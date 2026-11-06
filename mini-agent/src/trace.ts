/**
 * Trace 落盘：结构化事件 + Markdown 追加写。
 *
 * 为什么单独一层：
 * - `TraceEntry` 是「一行给人看的摘要」，够 CLI 打印，不够事后复盘；
 * - 这里用 discriminated union 描述「发生了什么」，公共字段统一为 seq / ts / turn / type：
 *   seq 从 1 递增、ts 是 ISO 时间、turn 是轮次（run.start 为 0，run.end 发的是最终轮次，
 *   与其自带的 turns 字段同值）；
 * - `MarkdownSink` 每条事件追加写一次并 fsync，进程在任意时刻崩掉，前面已写的事件都还在；
 * - trace 只落盘、**不进模型上下文**：不占 token，也不新增任何工具位（刻意没有 read_trace 工具）。
 *
 * 快照：只对「被写的文件」抓（write_file / edit_file 覆盖前），新建文件没有原内容可存。
 * 快照落在 `.trace/<runId>/snapshots/` 下，事件里记的是相对 run 目录的路径。
 *
 * 零运行时依赖，只用 Node 标准库。
 */

import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ErrorKind } from './errors.js';
import { sha256Hex } from './tools/base.js';
import type { Message, StopReason, ToolEffect, ToolSnapshot, Usage, UsageSnapshot } from './types.js';

/** 默认 trace 根目录（相对当前工作目录） */
export const DEFAULT_TRACE_DIR = '.trace';

/** 每次 run 的 trace 文件名 */
export const TRACE_FILE_NAME = 'trace.markdown';

/** 原文件快照的子目录名 */
export const SNAPSHOT_DIR = 'snapshots';

/** 事件类型：一眼能看出这一节是什么 */
export type TraceEventType =
  | 'run.start'
  | 'run.end'
  | 'model.reply'
  | 'tool.call'
  | 'tool.result'
  | 'fs.write'
  | 'context.compact'
  | 'memory.inject'
  | 'model.retry'
  | 'error';

/** 所有事件的公共字段 */
export interface TraceEventBase {
  /** 本次 run 内从 1 递增 */
  seq: number;
  /** ISO 时间戳 */
  ts: string;
  /** 轮次；run.start 为 0，run.end 为本次 run 的最终轮次（与 RunEndEvent.turns 一致） */
  turn: number;
}

/** run 起点：输入、模型、沙箱与系统提示摘要 */
export interface RunStartEvent extends TraceEventBase {
  type: 'run.start';
  /** 完整的用户输入 */
  input: string;
  /** 模型名；取不到时是 'unknown' */
  model: string;
  /** 文件工具的沙箱根目录（绝对路径） */
  sandboxRoot: string;
  /** 系统提示摘要（完整提示在 messages 里） */
  systemPrompt: string;
}

/** run 终点：终止原因、轮次、用量汇总 */
export interface RunEndEvent extends TraceEventBase {
  type: 'run.end';
  stopReason: StopReason;
  turns: number;
  usage: UsageSnapshot;
  /** 与 TraceEntry.note 同口径的一行中文用量汇总 */
  usageSummary: string;
}

/** model.reply / tool.call 里出现的工具调用摘要 */
export interface TraceToolCall {
  id: string;
  name: string;
  /** 参数；model.reply 里是摘要，tool.call 里是原文 */
  arguments: string;
}

/** 一次成功的模型回复：assistant content 全文 + tool_calls 摘要 + 本轮压缩/记忆情况 */
export interface ModelReplyEvent extends TraceEventBase {
  type: 'model.reply';
  content: string;
  toolCalls: TraceToolCall[];
  usage?: Usage;
  durationMs: number;
  /** 第几次尝试成功（>1 表示重试过） */
  attempts: number;
  /** 本次发给模型的消息是否被三层压缩改写过 */
  compressed: boolean;
  /** 本轮注入的记忆条数 */
  memoryHits: number;
}

/** 工具调用（一次逻辑调用一条，重试不重复发） */
export interface ToolCallEvent extends TraceEventBase {
  type: 'tool.call';
  toolName: string;
  /** 模型给出的原始参数 JSON 字符串 */
  arguments: string;
  toolCallId: string;
}

/** 工具结果（含重试后的最终结果） */
export interface ToolResultEvent extends TraceEventBase {
  type: 'tool.result';
  toolName: string;
  ok: boolean;
  durationMs: number;
  /** 一共尝试了几次 */
  attempts: number;
  error?: string;
  retryable?: boolean;
  /** 结果摘要（全文在 messages 里） */
  output: string;
}

/** 文件写入：路径、字节、覆盖与否、前后 sha256、原文件快照 */
export interface FsWriteEvent extends TraceEventBase {
  type: 'fs.write';
  /** 由哪个工具产生：write_file 或 edit_file */
  operation: 'fs.write' | 'edit';
  path: string;
  bytes: number;
  overwritten: boolean;
  beforeSha256?: string;
  afterSha256?: string;
  /** 原文件快照的相对路径，例如 snapshots/1-notes.txt */
  snapshot?: string;
  /** 路径一定在沙箱内；保留字段便于日后加拒绝分支 */
  allowed: true;
}

/** 上下文压缩：触发层级、压缩前后体积、丢弃条数、notes */
export interface ContextCompactEvent extends TraceEventBase {
  type: 'context.compact';
  layers: { layer1: number; layer2: number; layer3: number };
  charsBefore: number;
  charsAfter: number;
  /** 压缩后消息序列的 token 估算值 */
  estimatedTokens: number;
  /** 实际从「发给模型的消息」里去掉的条数 */
  dropped: number;
  notes: string[];
}

/** 记忆注入：命中条数、查询词、注入摘要 */
export interface MemoryInjectEvent extends TraceEventBase {
  type: 'memory.inject';
  hitCount: number;
  /** 用于召回的查询词（最后一条 user 消息） */
  query: string;
  /** 注入的 [相关记忆] 摘要；没命中时是说明文字 */
  summary: string;
}

/** 模型调用重试：第几次、退避多久、错误分类（来自 errors.ts） */
export interface ModelRetryEvent extends TraceEventBase {
  type: 'model.retry';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  kind: ErrorKind;
  reason: string;
}

/** 错误：复用 src/errors.ts 的分类结论，不自己发明分类 */
export interface ErrorEvent extends TraceEventBase {
  type: 'error';
  scope: 'model' | 'tool' | 'session' | 'misc';
  kind: ErrorKind;
  reason: string;
  message: string;
}

export type TraceEvent =
  | RunStartEvent
  | RunEndEvent
  | ModelReplyEvent
  | ToolCallEvent
  | ToolResultEvent
  | FsWriteEvent
  | ContextCompactEvent
  | MemoryInjectEvent
  | ModelRetryEvent
  | ErrorEvent;

/** 事件草稿：不含公共字段，由 loop 用 stampEvent 补齐 seq / ts / turn */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type TraceEventDraft = DistributiveOmit<TraceEvent, 'seq' | 'ts' | 'turn'>;

/** 补齐公共字段；turn 缺省 0 表示非轮次事件 */
export function stampEvent(
  draft: TraceEventDraft,
  seq: number,
  turn = 0,
  now: Date = new Date(),
): TraceEvent {
  return { ...draft, seq, ts: now.toISOString(), turn } as TraceEvent;
}

/** 工具声明的文件副作用 -> fs.write 事件草稿（公共字段由 loop 补齐） */
export function fsWriteEvent(effect: ToolEffect): Extract<TraceEventDraft, { type: 'fs.write' }> {
  return {
    type: 'fs.write',
    operation: effect.type,
    path: effect.path,
    bytes: effect.bytes,
    overwritten: effect.overwritten,
    ...(effect.beforeSha256 !== undefined ? { beforeSha256: effect.beforeSha256 } : {}),
    ...(effect.afterSha256 !== undefined ? { afterSha256: effect.afterSha256 } : {}),
    ...(effect.snapshot !== undefined ? { snapshot: effect.snapshot } : {}),
    allowed: true,
  };
}

/**
 * trace 消费者：loop 只依赖这个接口，MarkdownSink 只是其中一种实现。
 * snapshot / finalize 是可选的扩展能力，不支持的 sink 直接不实现即可。
 */export interface TraceSink {
  /** 落盘一条事件；实现方可以返回 Promise，loop 不会等它 */
  emit(event: TraceEvent): void | Promise<void>;
  /** 可选：抓原文件快照，返回 sha256 与快照相对路径；不支持时返回 undefined */
  snapshot?(absolutePath: string, relativePath: string): Promise<ToolSnapshot | undefined>;
  /** 可选：run 结束时追加完整消息序列，便于复现 */
  finalize?(messages: readonly Message[]): void | Promise<void>;
}

/** 单行摘要，避免人读部分被大段内容撑爆（全文仍在下面的 json 里） */
function clip(text: string, limit = 200): string {
  const singleLine = (text ?? '').replace(/\s+/g, ' ').trim();
  if (singleLine.length <= limit) return singleLine;
  return `${singleLine.slice(0, limit)}…`;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** 生成默认 runId：本地时间 + 随机后缀，按名字排序即按时间排序 */
export function createRunId(now: Date = new Date(), random: () => number = Math.random): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.floor(random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return `${stamp}-${suffix}`;
}

/** runId 只保留文件名安全字符，防止调用方传进来 ../ 之类的东西 */
function sanitizeRunId(input: string): string {
  const cleaned = input.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '');
  return cleaned === '' ? createRunId() : cleaned;
}

/** 快照文件名：逐段清洗，保留目录层级 */
function sanitizeRelative(input: string): string {
  const parts = input
    .split(/[\\/]+/)
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .map((part) => part.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim())
    .filter((part) => part !== '');
  return parts.length > 0 ? parts.join('/') : 'file';
}

/** 事件的人读描述：每行一条要点，详细字段看下面的 json */
function describe(event: TraceEvent): string[] {
  switch (event.type) {
    case 'run.start':
      return [
        `输入：${clip(event.input, 300) || '（空）'}`,
        `模型：${event.model}`,
        `沙箱根：${event.sandboxRoot}`,
        `系统提示：${event.systemPrompt || '（无）'}`,
      ];
    case 'run.end':
      return [
        `终止原因：${event.stopReason}`,
        `轮次：${event.turns}`,
        `用量：${event.usageSummary}`,
        `累计 token：${event.usage.totalTokens}（prompt=${event.usage.promptTokens} / completion=${event.usage.completionTokens}）`,
      ];
    case 'model.reply': {
      const calls =
        event.toolCalls.length > 0
          ? event.toolCalls.map((call) => `${call.name}(${call.arguments})`).join('; ')
          : '（无，直接回复）';
      return [
        `耗时：${event.durationMs}ms，尝试 ${event.attempts} 次`,
        `压缩：${event.compressed ? '本轮改写过消息' : '未压缩'}，记忆命中：${event.memoryHits} 条`,
        `tool_calls：${calls}`,
        `content：${clip(event.content, 300) || '（空）'}`,
        ...(event.usage
          ? [`usage：total=${event.usage.totalTokens ?? '-'}（prompt=${event.usage.promptTokens ?? '-'} / completion=${event.usage.completionTokens ?? '-'}）`]
          : ['usage：上游未返回']),
      ];
    }
    case 'tool.call':
      return [
        `工具：${event.toolName}（${event.toolCallId}）`,
        `参数：${clip(event.arguments, 300) || '（空）'}`,
      ];
    case 'tool.result':
      return [
        `工具：${event.toolName} -> ${event.ok ? 'ok' : 'fail'}`,
        `耗时：${event.durationMs}ms，尝试 ${event.attempts} 次`,
        `retryable：${event.retryable === undefined ? '未声明' : String(event.retryable)}`,
        ...(event.error ? [`error：${event.error}`] : []),
        `output：${clip(event.output, 300) || '（空）'}`,
      ];
    case 'fs.write':
      return [
        `操作：${event.operation} -> ${event.path}`,
        `字节：${event.bytes}，${event.overwritten ? '覆盖已有文件' : '新建文件'}，allowed=${event.allowed}`,
        `sha256：${event.beforeSha256 ?? '（新建，无原文件）'} -> ${event.afterSha256 ?? '（未计算）'}`,
        `快照：${event.snapshot ?? '（无）'}`,
      ];
    case 'context.compact':
      return [
        `层级：layer1=${event.layers.layer1} layer2=${event.layers.layer2} layer3=${event.layers.layer3}`,
        `字符：${event.charsBefore} -> ${event.charsAfter}，token≈${event.estimatedTokens}`,
        `丢弃消息：${event.dropped} 条`,
        ...event.notes.map((note) => `note：${note}`),
      ];
    case 'memory.inject':
      return [
        `命中：${event.hitCount} 条`,
        `查询：${clip(event.query, 200) || '（无）'}`,
        `注入：${clip(event.summary, 300)}`,
      ];
    case 'model.retry':
      return [
        `第 ${event.attempt}/${event.maxAttempts} 次失败`,
        `退避：${event.delayMs}ms`,
        `分类：${event.kind}（${event.reason}）`,
      ];
    case 'error':
      return [
        `范围：${event.scope}`,
        `分类：${event.kind}（${event.reason}）`,
        `信息：${clip(event.message, 300)}`,
      ];
    default:
      return [];
  }
}

/** 用 4 个反引号包住含 ``` 的内容，避免 json 里的代码块把 Markdown 截断 */
function fenced(language: string, body: string): string[] {
  const fence = body.includes('```') ? '````' : '```';
  return [`${fence}${language}`, body, fence];
}

/** 一条事件渲染成一节：人读描述 + json 代码块 */
function renderEvent(event: TraceEvent): string {
  const json = JSON.stringify(event, null, 2);
  const lines = [
    `## #${event.seq} ${event.type}（turn ${event.turn}）`,
    '',
    `- 时间：${event.ts}`,
    ...describe(event).map((line) => `- ${line}`),
    '',
    ...fenced('json', json),
    '',
    '',
  ];
  return lines.join('\n');
}

/** 文件末尾的完整消息序列：复现用，不进模型上下文 */
function renderMessages(messages: readonly Message[]): string {
  const json = JSON.stringify(messages, null, 2);
  return [`## 完整 messages（复现用，共 ${messages.length} 条）`, '', ...fenced('json', json), '', ''].join('\n');
}

export interface MarkdownSinkOptions {
  /** trace 根目录；缺省 <cwd>/.trace。每次 run 会再建一层 <runId> */
  dir?: string;
  /** 本次 run 的 id；缺省按时间 + 随机后缀生成 */
  runId?: string;
  /** 时钟，测试可注入 */
  now?: () => Date;
  /** 写失败回调（默认静默吞掉，只影响 trace 不影响对话） */
  onError?: (error: unknown) => void;
}

/**
 * Markdown trace sink：只做追加写。
 *
 * - 每条事件写一次并 fsync，崩溃时已写内容不丢；
 * - 内部用一个 promise 队列串行化，事件顺序 = 调用顺序；
 * - 写失败不抛给调用方：记 lastError 并回调 onError，对话本身不受影响；
 * - 同时提供 snapshot()：覆盖前把原文件复制到 snapshots/ 并算 sha256。
 */
export class MarkdownSink implements TraceSink {
  readonly runId: string;
  /** 本次 run 的 trace 目录：<dir>/<runId> */
  readonly dir: string;
  /** trace.markdown 的绝对路径 */
  readonly filePath: string;
  private readonly snapshotDir: string;
  private readonly now: () => Date;
  private readonly onError: ((error: unknown) => void) | undefined;
  private queue: Promise<void> = Promise.resolve();
  private snapshotCount = 0;
  private started = false;
  private lastError: unknown;

  constructor(options: MarkdownSinkOptions = {}) {
    this.runId = sanitizeRunId(options.runId ?? createRunId(options.now?.() ?? new Date()));
    const baseDir =
      options.dir && options.dir.trim() !== ''
        ? path.resolve(options.dir)
        : path.resolve(process.cwd(), DEFAULT_TRACE_DIR);
    this.dir = path.join(baseDir, this.runId);
    this.filePath = path.join(this.dir, TRACE_FILE_NAME);
    this.snapshotDir = path.join(this.dir, SNAPSHOT_DIR);
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError;
  }

  /** 最近一次写失败的原因（调试用；不影响返回值） */
  get error(): unknown {
    return this.lastError;
  }

  /** 追加一条事件；返回的 Promise 永远 resolve（失败走 onError） */
  emit(event: TraceEvent): Promise<void> {
    return this.enqueue(() => {
      const header = this.started ? '' : this.header();
      this.started = true;
      return this.append(`${header}${renderEvent(event)}`);
    });
  }

  /** run 结束时追加完整 messages 序列；排在前面的 emit 之后 */
  finalize(messages: readonly Message[]): Promise<void> {
    return this.enqueue(() => this.append(renderMessages(messages)));
  }

  /**
   * 覆盖前抓原文件快照：返回 sha256 与快照相对路径。
   * 文件读不到（新建文件）返回 undefined；写快照失败只回调 onError，仍返回 sha256。
   */
  async snapshot(absolutePath: string, relativePath: string): Promise<ToolSnapshot | undefined> {
    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch {
      return undefined;
    }
    const sha256 = sha256Hex(buffer);
    this.snapshotCount += 1;
    const name = `${this.snapshotCount}-${sanitizeRelative(relativePath)}`;
    try {
      const target = path.join(this.snapshotDir, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, buffer);
      return { sha256, snapshot: `${SNAPSHOT_DIR}/${name}` };
    } catch (error) {
      this.onError?.(error);
      return { sha256 };
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue
      .then(task)
      .catch((error: unknown) => {
        this.lastError = error;
        this.onError?.(error);
      });
    return this.queue;
  }

  /** 追加写 + fsync：等价于「每条事件都 flush 一次」 */
  private async append(text: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const handle = await open(this.filePath, 'a');
    try {
      await handle.write(text, null, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private header(): string {
    return [
      `# Trace ${this.runId}`,
      '',
      `- 目录：${this.dir}`,
      `- 开始：${this.now().toISOString()}`,
      '- 说明：每条事件一节；末尾附本次完整 messages。trace 只落盘，不进模型上下文、不占 token。',
      '',
    ].join('\n');
  }
}
