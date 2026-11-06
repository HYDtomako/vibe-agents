/**
 * 会话持久化：一个会话一个 JSON 文件，重启后能续聊。
 *
 * 存储：<dir>/<id>.json，内容 { id, messages, createdAt, updatedAt }
 *   - 目录默认 <cwd>/.sessions，测试必须注入 tmpdir；
 *   - id 只允许 [A-Za-z0-9_.-]，其余字符替换为 _，最长 64；
 *     非法/空 id 会被规范化或自动生成（s-<timestamp>-<rand4>），
 *     因此 `/`、`\`、`:`、`..` 都无法拼出目录外路径。
 *
 * 写入：先写 <file>.tmp 再 rename，避免进程中断留下半个文件。
 * 读取：文件不存在视为空会话；JSON 损坏时把文件改名为
 *   <file>.corrupt-<ts> 并当作空会话返回，绝不抛异常打断上层。
 *
 * 只依赖 node:fs/promises、node:path、node:crypto。
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Message, Role, SessionState } from './types.js';

/** 会话文件目录名（相对 cwd） */
export const DEFAULT_SESSIONS_DIR = '.sessions';

/** id 长度上限 */
export const MAX_SESSION_ID_LENGTH = 64;

const ROLES = new Set<Role>(['system', 'user', 'assistant', 'tool']);

export interface SessionStoreOptions {
  /** 会话目录，默认 <cwd>/.sessions；测试必须注入 tmpdir */
  dir?: string;
  /** 时间源（毫秒时间戳），测试可注入 */
  now?: () => number;
}

/** 会话摘要：列出会话时不带完整消息，省内存也避免误把历史打出来 */
export interface SessionSummary {
  id: string;
  /** 消息条数 */
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * id 规范化：非法字符换 _，连续的点折成 _（防 `..`），去掉首尾的点（防隐藏文件），
 * 截断到 64。返回空字符串表示「原 id 无法使用」，由调用方决定自动生成还是拒绝。
 */
export function normalizeSessionId(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/\.{2,}/g, '_');
  const edgeTrimmed = cleaned.replace(/^\.+/, '').replace(/\.+$/, '');
  const sliced = edgeTrimmed.slice(0, MAX_SESSION_ID_LENGTH).replace(/\.+$/, '');
  // 一个字母数字都没有的 id（如 '_' / ''）没有信息量，交给上层自动生成
  return /[A-Za-z0-9]/.test(sliced) ? sliced : '';
}

/** 校验一条消息是否可用；脏数据直接丢弃，避免把损坏内容回灌给模型 */
function sanitizeMessage(value: unknown): Message | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const role = raw['role'];
  if (typeof role !== 'string' || !ROLES.has(role as Role)) return undefined;
  if (typeof raw['content'] !== 'string') return undefined;

  const message: Message = { role: role as Role, content: raw['content'] };
  if (typeof raw['name'] === 'string') message.name = raw['name'];
  if (typeof raw['toolCallId'] === 'string') message.toolCallId = raw['toolCallId'];
  if (typeof raw['createdAt'] === 'number') message.createdAt = raw['createdAt'];
  if (Array.isArray(raw['toolCalls'])) {
    const toolCalls = raw['toolCalls']
      .map((call) => {
        if (call === null || typeof call !== 'object') return undefined;
        const item = call as Record<string, unknown>;
        if (typeof item['id'] !== 'string' || typeof item['name'] !== 'string') return undefined;
        return {
          id: item['id'],
          name: item['name'],
          arguments: typeof item['arguments'] === 'string' ? item['arguments'] : '',
        };
      })
      .filter((call): call is NonNullable<typeof call> => call !== undefined);
    if (toolCalls.length > 0) message.toolCalls = toolCalls;
  }
  return message;
}

export class SessionStore {
  readonly dir: string;
  private readonly now: () => number;

  constructor(options: SessionStoreOptions = {}) {
    this.dir = path.resolve(options.dir ?? path.join(process.cwd(), DEFAULT_SESSIONS_DIR));
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 把外部输入（用户敲的 id、环境变量）规范成可落盘的文件名。
   * 空串或全是非法字符时自动生成新 id，保证返回值永远可安全用作文件名。
   */
  resolveId(raw?: string): string {
    const normalized = normalizeSessionId(raw ?? '');
    if (normalized !== '' && normalized !== '.' && normalized !== '..') return normalized;
    return this.generateId();
  }

  /** 生成形如 s-1750000000000-9f3c 的新 id */
  private generateId(): string {
    return `s-${this.now()}-${randomBytes(2).toString('hex')}`;
  }

  /** 会话文件绝对路径；规范化后不含分隔符，天然落在 dir 内 */
  private fileFor(id: string): string {
    const file = path.resolve(this.dir, `${id}.json`);
    const relative = path.relative(this.dir, file);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`会话 id 越界：${id}`);
    }
    return file;
  }

  async exists(id: string): Promise<boolean> {
    try {
      const info = await stat(this.fileFor(this.resolveId(id)));
      return info.isFile();
    } catch {
      return false;
    }
  }

  /** 列出全部会话（按 updatedAt 倒序）；损坏文件会先被改名再跳过 */
  async list(): Promise<SessionSummary[]> {
    let names: string[];
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      names = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name.slice(0, -'.json'.length));
    } catch {
      return [];
    }

    const summaries: SessionSummary[] = [];
    for (const name of names) {
      const state = await this.load(name);
      summaries.push({
        id: state.id,
        messageCount: state.messages.length,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      });
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    return summaries;
  }

  /** 读一个会话；文件不存在或损坏都返回空会话（损坏文件会被改名留档） */
  async load(id: string): Promise<SessionState> {
    const sessionId = this.resolveId(id);
    const file = this.fileFor(sessionId);

    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return this.emptyState(sessionId);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      await this.quarantine(file);
      return this.emptyState(sessionId);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      await this.quarantine(file);
      return this.emptyState(sessionId);
    }

    const raw = parsed as Record<string, unknown>;
    if (!Array.isArray(raw['messages'])) {
      await this.quarantine(file);
      return this.emptyState(sessionId);
    }

    const messages = raw['messages']
      .map((message) => sanitizeMessage(message))
      .filter((message): message is Message => message !== undefined);
    const now = this.now();
    const createdAt = typeof raw['createdAt'] === 'number' ? raw['createdAt'] : now;
    const updatedAt = typeof raw['updatedAt'] === 'number' ? raw['updatedAt'] : createdAt;
    return { id: sessionId, messages, createdAt, updatedAt };
  }

  /** 新建会话；id 已存在时原样返回已有状态，不覆盖历史 */
  async create(id?: string): Promise<SessionState> {
    const sessionId = this.resolveId(id);
    if (await this.exists(sessionId)) return this.load(sessionId);
    return this.save(sessionId, []);
  }

  /** 写入一个会话（原子写：先 .tmp 再 rename），createdAt 沿用已有文件的 */
  async save(id: string, messages: Message[]): Promise<SessionState> {
    const sessionId = this.resolveId(id);
    const file = this.fileFor(sessionId);
    const previous = await this.load(sessionId);
    const now = this.now();
    const state: SessionState = {
      id: sessionId,
      messages: messages.map((message) => ({ ...message })),
      // 文件不存在时 load 返回的空会话 createdAt 就是现在，等价于「新建即创建时间」
      createdAt: previous.createdAt,
      updatedAt: now,
    };

    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
    return state;
  }

  /** 删除会话文件；返回是否真的删掉了 */
  async delete(id: string): Promise<boolean> {
    const sessionId = this.resolveId(id);
    if (!(await this.exists(sessionId))) return false;
    await rm(this.fileFor(sessionId), { force: true });
    return true;
  }

  private emptyState(id: string): SessionState {
    const now = this.now();
    return { id, messages: [], createdAt: now, updatedAt: now };
  }

  /** 把损坏文件改名留档；改名失败也不抛，交给上层当空会话处理 */
  private async quarantine(file: string): Promise<void> {
    try {
      await rename(file, `${file}.corrupt-${this.now()}`);
    } catch {
      // 留档失败只能放弃：损坏内容不能进入模型上下文
    }
  }
}
