/**
 * 记忆层：Markdown 持久化 + grep 检索 + 词面打分召回。
 *
 * 存储：<dir>/cli.md，每条一行
 *   - [YYYY-MM-DD HH:mm] #tag 内容
 * （给了 tag 时同时写 #kind 与 #tag，便于按类别与话题分别加权）
 *
 * 检索：复用 tools/grep-core.ts 扫整个 memory/ 目录拿候选行，再按词面命中数、完整短语、
 * #tag、时间近因、长度惩罚打分排序。这是**词面打分近似语义**，不是向量检索：
 * 不做同义词/释义匹配，召回质量取决于用词是否重合。
 *
 * 记忆是跨会话的用户档案：固定单文件、全局共享，不随 sessionId 切换。
 *
 * 写入：remember 工具（模型主动记）+ loop 结束时自动记一条 kind=decision。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { defineTool, toolFail, toolOk } from './tools/base.js';
import { grepFiles } from './tools/grep-core.js';

export type MemoryKind = 'fact' | 'preference' | 'todo' | 'decision';

export const MEMORY_KINDS: readonly MemoryKind[] = ['fact', 'preference', 'todo', 'decision'];

/** 记忆读写失败时抛出，由工具层/loop 兜底 */
export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryError';
  }
}

export interface MemoryEntry {
  /** 'YYYY-MM-DD HH:mm'（本地时间） */
  timestamp: string;
  kind: MemoryKind;
  /** 最具体的一个 tag；没有显式 tag 时等于 kind */
  tag: string;
  tags: string[];
  content: string;
  /** 记忆文件的绝对路径 */
  file: string;
  /** 1 起始行号 */
  line: number;
}

export interface MemoryHit extends MemoryEntry {
  score: number;
}

export interface MemorySearchOptions {
  /** 返回条数上限，默认 5 */
  topK?: number;
  /** 低于该分数丢弃，默认 0.5 */
  minScore?: number;
}

export interface MemoryAppendInput {
  text: string;
  tag?: string;
  kind?: MemoryKind;
}

export interface MemoryAppendResult {
  path: string;
  /** 写入后的总条数 */
  count: number;
  /** false 表示内容已存在，未重复写入 */
  added: boolean;
  line?: string;
}

export interface MemoryStoreOptions {
  /** 记忆目录，默认 <cwd>/memory；测试必须注入 tmpdir */
  dir?: string;
  /** 单文件条数上限，默认 2000 */
  maxEntries?: number;
  /** 时间源，测试可注入 */
  now?: () => Date;
  /** 默认 topK，默认 5 */
  topK?: number;
}

/**
 * 记忆文件名：固定 cli.md。
 * 沿用既有默认会话名 cli，保证已落盘的老数据（memory/cli.md）继续可读；
 * 记忆是全局用户档案，不再按会话派生文件名。
 */
const MEMORY_FILE_NAME = 'cli.md';

/** 英文停用词 */
const EN_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'and', 'or',
  'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'that', 'this', 'these', 'those', 'it',
  'its', 'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'our', 'their', 'me', 'us', 'them',
  'do', 'does', 'did', 'done', 'have', 'has', 'had', 'what', 'which', 'who', 'how', 'when',
  'where', 'why', 'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'please',
  'not', 'no', 'yes', 'if', 'then', 'than', 'so', 'but', 'also', 'just', 'about', 'into',
]);

/** 中文停用词（含常见 2-gram 虚词组合） */
const CN_STOPWORDS = new Set([
  '的', '了', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '是', '在', '有', '和', '与', '就', '也',
  '都', '很', '要', '把', '被', '给', '对', '从', '到', '这', '那', '我', '你', '他', '她', '它',
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '一下', '帮我', '请帮', '一个',
  '可以', '需要', '现在', '然后', '还是', '就是', '因为', '所以', '但是', '如果', '以及',
]);

/** query 分词：英文单词小写去停用词，中文取 2-gram */
export function tokenizeQuery(query: string): string[] {
  const lower = query.toLowerCase();
  const tokens: string[] = [];

  for (const match of lower.matchAll(/[a-z0-9_]+/g)) {
    const word = match[0];
    if (word.length >= 2 && !EN_STOPWORDS.has(word)) tokens.push(word);
  }

  for (const match of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0];
    if (run.length === 1) {
      if (!CN_STOPWORDS.has(run)) tokens.push(run);
      continue;
    }
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const gram = run.slice(index, index + 2);
      if (CN_STOPWORDS.has(gram)) continue;
      // 两个字都是虚词的组合（如「的了」）同样丢弃
      if ([...gram].every((char) => CN_STOPWORDS.has(char))) continue;
      tokens.push(gram);
    }
  }

  return [...new Set(tokens)];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseTimestamp(timestamp: string): number {
  const parsed = Date.parse(timestamp.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : 0;
}

const LINE_PATTERN = /^-\s*\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*(.*)$/;

/** 从一行 Markdown 解析出记忆条目；解析失败返回 null */
export function parseMemoryLine(line: string, file: string, lineNumber: number): MemoryEntry | null {
  const match = LINE_PATTERN.exec(line.trim());
  if (!match) return null;

  const timestamp = match[1]!;
  let rest = match[2] ?? '';
  const tags: string[] = [];
  while (rest.startsWith('#')) {
    const spaceIndex = rest.indexOf(' ');
    if (spaceIndex === -1) {
      tags.push(rest.slice(1));
      rest = '';
      break;
    }
    tags.push(rest.slice(1, spaceIndex));
    rest = rest.slice(spaceIndex + 1).trimStart();
  }

  const content = rest.trim();
  if (content === '') return null;

  const kind = (tags.find((tag) => (MEMORY_KINDS as readonly string[]).includes(tag)) ?? 'fact') as MemoryKind;
  const tag = tags.filter((item) => item !== kind).at(-1) ?? kind;

  return { timestamp, kind, tag, tags, content, file, line: lineNumber };
}

/**
 * 词面打分：
 *   命中词数 × 1.0 + 完整短语命中 +3 + #tag 命中 +1.5
 *   + 时间近因（exp(-ageDays/7)，越新越接近 1）
 *   - 长度惩罚（最多 0.5，避免长条目光靠堆字取胜）
 */
export function scoreMemoryEntry(entry: MemoryEntry, terms: string[], phrase: string, now: Date): number {
  const content = entry.content.toLowerCase();
  const tags = entry.tags.join(' ').toLowerCase();

  let matched = 0;
  for (const term of terms) {
    if (content.includes(term) || tags.includes(term)) matched += 1;
  }
  let score = matched * 1.0;

  if (phrase !== '' && (content.includes(phrase) || tags.includes(phrase))) score += 3;
  if (terms.some((term) => tags.includes(term))) score += 1.5;

  const timestamp = parseTimestamp(entry.timestamp);
  const ageDays = timestamp > 0 ? Math.max(0, (now.getTime() - timestamp) / 86_400_000) : 365;
  score += Math.exp(-ageDays / 7);

  score -= Math.min(0.5, entry.content.length / 800);
  return score;
}

/** 把召回结果拼成注入用的 system 消息内容 */
export function formatMemoryForPrompt(hits: readonly MemoryHit[]): string {
  const lines = ['[相关记忆]'];
  for (const hit of hits) {
    const day = hit.timestamp.slice(0, 10);
    lines.push(`- (${day}) [#${hit.tag}] ${hit.content}`);
  }
  return lines.join('\n');
}

export class MemoryStore {
  readonly dir: string;
  readonly filePath: string;
  readonly maxEntries: number;
  readonly defaultTopK: number;
  private readonly now: () => Date;

  constructor(options: MemoryStoreOptions = {}) {
    this.dir = path.resolve(options.dir ?? path.join(process.cwd(), 'memory'));
    this.filePath = path.join(this.dir, MEMORY_FILE_NAME);
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 2000));
    this.defaultTopK = Math.max(1, Math.floor(options.topK ?? 5));
    this.now = options.now ?? (() => new Date());
  }

  /** 读取全部条目（文件不存在视为空） */
  async list(): Promise<MemoryEntry[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const entries: MemoryEntry[] = [];
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const entry = parseMemoryLine(lines[index]!, this.filePath, index + 1);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async count(): Promise<number> {
    return (await this.list()).length;
  }

  /** 追加一条记忆；内容重复时返回 added=false，超过上限抛 MemoryError */
  async append(input: MemoryAppendInput): Promise<MemoryAppendResult> {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (text === '') throw new MemoryError('记忆内容 text 不能为空');

    const kind: MemoryKind = (MEMORY_KINDS as readonly string[]).includes(input.kind ?? '')
      ? (input.kind as MemoryKind)
      : 'fact';
    const rawTag = typeof input.tag === 'string' ? input.tag.replace(/^#+/, '').trim().replace(/\s+/g, '-') : '';

    const entries = await this.list();
    const normalized = text.replace(/\s+/g, ' ');
    if (entries.some((entry) => entry.content.replace(/\s+/g, ' ') === normalized)) {
      return { path: this.filePath, count: entries.length, added: false };
    }
    if (entries.length >= this.maxEntries) {
      throw new MemoryError(`记忆文件已达上限 ${this.maxEntries} 条（${this.filePath}），请先清理`);
    }

    const tags = rawTag === '' || rawTag === kind ? [`#${kind}`] : [`#${kind}`, `#${rawTag}`];
    const line = `- [${formatTimestamp(this.now())}] ${tags.join(' ')} ${normalized}`;

    await mkdir(this.dir, { recursive: true });
    await appendFile(this.filePath, `${line}\n`, 'utf8');

    return { path: this.filePath, count: entries.length + 1, added: true, line };
  }

  /**
   * 词面检索：先用 grep-core 扫整个 memory/ 目录拿候选行，再打分排序。
   * 记忆全局共享，目录里所有文件的行都参与召回。空 query 直接返回空数组。
   */
  async search(query: string, options: MemorySearchOptions = {}): Promise<MemoryHit[]> {
    const trimmed = (query ?? '').trim();
    if (trimmed === '') return [];

    const terms = tokenizeQuery(trimmed);
    if (terms.length === 0) return [];

    const topK = Math.max(1, Math.floor(options.topK ?? this.defaultTopK));
    const minScore = options.minScore ?? 0.5;
    const phrase = trimmed.toLowerCase();

    const pattern = terms
      .slice()
      .sort((a, b) => b.length - a.length)
      .map((term) => escapeRegExp(term))
      .join('|');

    let matches;
    try {
      const result = await grepFiles({
        root: this.dir,
        pattern,
        regex: true,
        ignoreCase: true,
        maxResults: this.maxEntries,
        skipDirs: [],
      });
      matches = result.matches;
    } catch {
      return [];
    }

    const now = this.now();
    const hits: MemoryHit[] = [];
    for (const match of matches) {
      const entry = parseMemoryLine(match.text, match.file, match.line);
      if (!entry) continue;
      const score = scoreMemoryEntry(entry, terms, phrase, now);
      if (score < minScore) continue;
      hits.push({ ...entry, score });
    }

    hits.sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp));
    return hits.slice(0, topK);
  }
}

/**
 * remember 工具：把一条需要长期记住的信息写入记忆文件。
 *
 * 一句话功能：模型主动把事实/偏好/待办/决策写进全局记忆文件 memory/cli.md，供后续轮次召回。
 * 参数：text（必填，一句话说清要记什么）；tag（可选标签，用于分类与加权）；kind（可选，默认 fact）。
 * 返回：写入成功的文件路径与当前条数；内容重复时说明「已存在，未重复写入」。
 * 失败情况：未配置记忆存储、text 为空、已达条数上限、磁盘写入失败时返回 ok=false。
 */
export const rememberTool = defineTool({
  name: 'remember',
  description:
    '把一条需要跨轮次记住的信息（事实/偏好/待办/决策）写入长期记忆文件，供后续对话按需召回。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要记住的内容，一句话说清' },
      tag: { type: 'string', description: '可选的标签，用于分类与加权，例如 "用户偏好"' },
      kind: {
        type: 'string',
        enum: ['fact', 'preference', 'todo', 'decision'],
        description: '记忆种类，默认 fact',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  todo: [
    '把用户明确要求记住、或后续会反复用到的事实写入持久化记忆文件。',
    '第一步：校验 text 非空；tag 可选，kind 只接受 fact / preference / todo / decision。',
    '第二步：读取已有记忆做去重，同样内容不重复写入。',
    '第三步：追加一行 `- [YYYY-MM-DD HH:mm] #kind #tag 内容`，返回文件路径与当前条数。',
    '边界：单文件上限 2000 条；不做修改与删除；不写入敏感凭据。',
    '失败情况：text 为空、未配置记忆存储、已达条数上限、磁盘写入失败时返回 ok=false。',
  ],
  async run(args, ctx) {
    const memory = ctx.memory;
    if (!memory) {
      return toolFail(
        '当前运行环境没有配置记忆存储（AgentLoop 的 memory 选项），无法写入记忆。',
        'MEMORY_UNAVAILABLE',
      );
    }
    const text = args['text'];
    if (typeof text !== 'string' || text.trim() === '') {
      return toolFail('text 必须是非空字符串', 'TEXT_REQUIRED');
    }
    const tag = typeof args['tag'] === 'string' ? args['tag'] : undefined;
    const rawKind = args['kind'];
    const kind =
      typeof rawKind === 'string' && (MEMORY_KINDS as readonly string[]).includes(rawKind)
        ? (rawKind as MemoryKind)
        : undefined;

    try {
      const result = await memory.append({ text, ...(tag ? { tag } : {}), ...(kind ? { kind } : {}) });
      const message = result.added
        ? `已写入记忆：${result.path}（当前 ${result.count} 条）`
        : `该内容已存在，未重复写入：${result.path}（当前 ${result.count} 条）`;
      return toolOk(message, result);
    } catch (error) {
      return toolFail(`写入记忆失败：${error instanceof Error ? error.message : String(error)}`, 'MEMORY_WRITE_FAILED');
    }
  },
});
