/**
 * Agent Loop：最小可用的 agent 运行时核心。
 *
 * 一轮（turn）做的事：
 *   1. 检查 token 预算（超了直接停止，不再调模型）；
 *   2. 把当前消息序列 + 工具声明发给模型（可重试错误会退避重试）；
 *   3. 模型要么直接回复（无 tool_calls）-> 结束并返回最终答案；
 *      要么给出一个或多个 tool_calls；
 *   4. 依次执行工具：临时失败自动重试，重试耗尽后把「失败回执」交回模型换策略；
 *   5. 回到第 1 步，直到 maxTurns 用尽或触发熔断/配额停止。
 *
 * 健壮性约定：
 * - 模型调用失败：不抛异常。quota -> quota_exhausted；可重试错误耗尽 -> retry_exhausted；
 *   400/401 等请求错误 -> model_error；answer 都是不含堆栈的中文文案；
 * - 工具失败：registry 保证不抛；loop 只对 retryable 失败重试，确定性失败立刻回灌；
 * - 同一工具同一 session 连续失败达到阈值（默认 3）：熔断，stopReason=tool_failure；
 * - 用量：每次模型调用后记账，loop 结束时在 trace 追加一条 kind=final 的用量汇总。
 *
 * 可观测性（trace 落盘）：
 * - LoopResult.trace 仍是「一行摘要」的 TraceEntry 列表，CLI 直接打印；
 * - 另有一条结构化事件流（src/trace.ts）：配了 TraceSink 时，每次 run 会依次发
 *   run.start / memory.inject / context.compact / model.reply / tool.call / tool.result /
 *   fs.write / model.retry / error / run.end，末尾追加完整 messages 便于复现；
 * - trace 只落盘、不进模型上下文，也不新增工具位，对话行为与不配 sink 时完全一致；
 * - sink 写失败一律降级：只影响 trace，不影响对话结果。
 *
 * 多 session 隔离（配了 sessions 才生效）：
 * - 本次 run 没显式给 history 时，从 SessionStore 读该会话历史，结束后把
 *   result.messages 去掉 system 写回；保存失败只写一条 trace，不影响返回；
 * - 记忆全局共享，不随会话切换：所有读写都用构造时传入的那一个 MemoryStore；
 * - 熔断计数按 sessionId 键控，一个会话熔断不影响另一个会话；
 * - 不传 sessions 时行为与单会话版本完全一致。
 *
 * 扩展点：sessionId 已贯穿 trace / 工具上下文；messages 作为返回值可被上层持久化。
 */

import {
  classifyModelError,
  classifyToolError,
  ToolExecutionError,
} from './errors.js';
import type { ErrorClassification } from './errors.js';
import { RetryError, withRetry } from './retry.js';
import type { SleepFn } from './retry.js';
import { UsageTracker } from './usage.js';
import { stampEvent } from './trace.js';
import type { TraceEventDraft, TraceSink } from './trace.js';
import type {
  LoopResult,
  LoopStats,
  Message,
  ModelClient,
  ModelResponse,
  StopReason,
  ToolResult,
  ToolSnapshot,
  ToolSpec,
  TraceEntry,
  Usage,
} from './types.js';
import { ContextEngine, MEMORY_MARKER } from './context.js';
import type { ContextStats } from './context.js';
import { formatMemoryForPrompt } from './memory.js';
import type { MemoryStore } from './memory.js';
import type { SessionStore } from './session.js';
import { resolveRoot, resolveSafePath } from './tools/fs-path.js';
import type { ToolRegistry } from './tools/registry.js';

/** 默认最大轮次 */
export const DEFAULT_MAX_TURNS = 8;

/** 没有显式给 sessionId 时使用的会话 id */
export const DEFAULT_SESSION_ID = 'default';

/** 同一工具连续失败多少次触发熔断 */
export const DEFAULT_TOOL_FAILURE_THRESHOLD = 3;

/** 额度不足时的用户可见文案（不含内部路径与密钥） */
export const QUOTA_ANSWER =
  'API 额度不足或计费被拒绝（HTTP 402 / insufficient_quota）。本次已停止，未重试。请检查账户余额或更换 key。';

/** 默认系统提示：约定义务、拒绝越权、要求失败时如实告知 */
export const DEFAULT_SYSTEM_PROMPT = [
  '你是一个最小可用的 agent。',
  '可以使用提供的工具来获取信息或计算结果；不需要工具时直接回答。',
  '调用工具前先确认参数，一次只做必要的事情。',
  '如果工具返回 ok=false，请阅读错误信息，决定修正参数重试或如实向用户说明。',
  '如果 tool 回执里写着 TOOL_RETRY_EXHAUSTED，说明已经自动重试过，请换工具、换参数或直接回答。',
  '回答使用简洁的中文。',
].join('\n');

/** trace 订阅者；CLI 用它把 trace 实时打印出来 */
export type TraceLogger = (entry: TraceEntry) => void;

/** 结构化事件发射器：补齐 seq/ts/turn 后交给 sink；没配 sink 时是空操作 */
export type TraceEmit = (draft: TraceEventDraft, turn?: number) => void;

/** loop 侧重试配置：可注入 sleep/random/now，测试不真等 */
export type LoopRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  deadlineMs?: number;
  signal?: AbortSignal;
  sleep?: SleepFn;
  random?: () => number;
  now?: () => number;
};

export interface AgentLoopOptions {
  model: ModelClient;
  registry: ToolRegistry;
  /** 最大轮次，默认 8；小于 1 会被纠正为 1 */
  maxTurns?: number;
  /** trace 收集方式之一：注入 logger（同时仍会累积到 LoopResult.trace） */
  logger?: TraceLogger;
  /** trace 落盘 sink（如在 CLI 里每次 run 传一个 MarkdownSink）；不传则只累积 TraceEntry */
  traceSink?: TraceSink;
  /** 模型名，只用于 trace 的 run.start；缺省从 model 客户端读取，读不到记 'unknown' */
  modelName?: string;
  /** 自定义系统提示；传空字符串表示不注入 system 消息 */
  systemPrompt?: string;
  /** 默认会话 id，写入 trace 与工具上下文；不传则用 'default' */
  sessionId?: string;
  /** 初始历史消息（续聊/多 session 时由上层注入，不含 system）；与 sessions 同时存在时 sessions 优先 */
  history?: Message[];
  /** 会话持久化存储；配置后 run 会自动读历史、结束后写回，实现重启续聊 */
  sessions?: SessionStore;
  /** 上下文压缩引擎；缺省用当前 model 作为摘要器自动创建 */
  context?: ContextEngine;
  /** 记忆存储；全局共享单文件，所有会话读写同一份 */
  memory?: MemoryStore;
  /** 每轮注入的记忆条数上限，默认 5 */
  memoryTopK?: number;
  /** 文件工具的沙箱根目录，默认 process.cwd() */
  rootDir?: string;
  /** 重试策略；默认 maxAttempts=3 / baseDelayMs=300 / maxDelayMs=4000 / jitter=true */
  retry?: LoopRetryOptions;
  /** 用量与预算记账；不传则在本次 run 内临时创建一个（不落盘、无预算） */
  usage?: UsageTracker;
  /** 同一工具同一 session 连续失败达到该值即熔断，默认 3 */
  toolFailureThreshold?: number;
}

export interface RunOptions {
  /** 本次运行的会话 id，覆盖构造参数 */
  sessionId?: string;
  /** 本次运行的历史消息，覆盖构造参数 */
  history?: Message[];
  /** 本次运行的 trace sink，覆盖构造参数（CLI 每次输入创建一个） */
  traceSink?: TraceSink;
}

/** 结果摘要截断，避免 trace 与日志被大结果撑爆 */
export function summarize(text: string, limit = 200): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= limit) return singleLine;
  return `${singleLine.slice(0, limit)}…`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/** 模型名只用于 trace：优先显式传入，其次从客户端上读，读不到记 'unknown' */
function resolveModelName(model: ModelClient, explicit?: string): string {
  if (explicit && explicit.trim() !== '') return explicit.trim();
  const named = (model as { model?: unknown }).model;
  return typeof named === 'string' && named.trim() !== '' ? named.trim() : 'unknown';
}

/** 工具结果回灌格式：结构化，便于模型判断成功/失败 */
function toolMessageContent(ok: boolean, output: string, error?: string): string {
  const payload: Record<string, unknown> = { ok, output };
  if (!ok && error) payload['error'] = error;
  return JSON.stringify(payload);
}

/** 构造「重试耗尽」的失败回执：让模型换策略，而不是把裸错甩给用户 */
export function buildToolFailureReceipt(
  toolName: string,
  lastResult: ToolResult | undefined,
  classification: ErrorClassification,
  attempts: number,
): ToolResult {
  const lastError = lastResult?.error ?? summarize(lastResult?.output ?? '（无错误详情）', 160);
  return {
    ok: false,
    output: [
      `工具 ${toolName} 调用失败（分类：${classification.kind}，原因：${classification.reason}）。`,
      `已重试 ${Math.max(0, attempts - 1)} 次仍失败（共 ${attempts} 次尝试）。`,
      `最后错误：${lastError}`,
      '建议：换一个工具或换参数重试；如果上游临时不可用，先向用户说明并给出已有结论。',
    ].join(' '),
    error: 'TOOL_RETRY_EXHAUSTED',
    retryable: false,
    ...(lastResult?.durationMs !== undefined ? { durationMs: lastResult.durationMs } : {}),
  };
}

type RecordTrace = (entry: TraceEntry) => void;
type MutableStats = Omit<LoopStats, 'usage'>;

/** 调模型前的准备结果：实际发给模型的消息 + 写进摘要的说明 + 结构化事件所需的信息 */
interface PreparedMessages {
  messages: Message[];
  note: string;
  /** 本轮注入的记忆条数 */
  memoryHits: number;
  /** 召回用的查询词（最后一条 user 消息） */
  memoryQuery: string;
  /** 注入的 [相关记忆] 内容；没命中为空串 */
  memorySummary: string;
  /** context.fit 的统计；fit 抛错时为 undefined */
  compact?: { stats: ContextStats; notes: string[]; dropped: number; changed: boolean };
}

interface ToolOutcome {
  result: ToolResult;
  attempts: number;
  classification: ErrorClassification;
}

interface ModelCallSuccess {
  ok: true;
  response: ModelResponse;
  attempts: number;
  durationMs: number;
}

interface ModelCallFailure {
  ok: false;
  classification: ErrorClassification;
  attempts: number;
  error: unknown;
  stopReason: Extract<StopReason, 'quota_exhausted' | 'retry_exhausted' | 'model_error'>;
}

type ModelCallOutcome = ModelCallSuccess | ModelCallFailure;

function classifyThrown(error: unknown): ErrorClassification {
  if (error instanceof ToolExecutionError) return error.classification;
  const message = errorMessage(error);
  return classifyToolError({ ok: false, output: message, error: message });
}

export class AgentLoop {
  private readonly model: ModelClient;
  private readonly registry: ToolRegistry;
  private readonly maxTurns: number;
  private readonly logger: TraceLogger | undefined;
  private readonly traceSink: TraceSink | undefined;
  private readonly modelName: string;
  private readonly systemPrompt: string;
  private readonly defaultSessionId: string | undefined;
  private readonly defaultHistory: Message[];
  private readonly context: ContextEngine;
  /** 记忆存储；跨会话全局共享，不按 sessionId 派生 */
  private readonly memory: MemoryStore | undefined;
  private readonly sessions: SessionStore | undefined;
  private readonly memoryTopK: number;
  private readonly rootDir: string | undefined;
  private readonly retryOptions: LoopRetryOptions;
  private readonly usage: UsageTracker;
  private readonly toolFailureThreshold: number;
  /** 同一工具同一 session 的连续失败计数；跨 run 保留，成功一次就清零 */
  private readonly failureStreaks = new Map<string, number>();

  constructor(options: AgentLoopOptions) {
    if (!options.model) throw new Error('AgentLoop 需要 model');
    if (!options.registry) throw new Error('AgentLoop 需要 registry');

    this.model = options.model;
    this.registry = options.registry;
    this.maxTurns = Math.max(1, Math.floor(options.maxTurns ?? DEFAULT_MAX_TURNS));
    this.logger = options.logger;
    this.traceSink = options.traceSink;
    this.modelName = resolveModelName(options.model, options.modelName);
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.defaultSessionId = options.sessionId;
    this.defaultHistory = options.history ? [...options.history] : [];
    this.context = options.context ?? new ContextEngine({ summarizer: options.model });
    this.memory = options.memory;
    this.sessions = options.sessions;
    this.memoryTopK = Math.max(1, Math.floor(options.memoryTopK ?? 5));
    this.rootDir = options.rootDir;
    this.retryOptions = options.retry ?? {};
    this.usage = options.usage ?? new UsageTracker();
    this.toolFailureThreshold = Math.max(
      1,
      Math.floor(options.toolFailureThreshold ?? DEFAULT_TOOL_FAILURE_THRESHOLD),
    );
  }

  /**
   * 调模型前的准备：先按最后一条 user 消息召回记忆，再跑一次 context.fit。
   * 返回实际发给模型的消息与写进 trace 的说明。任何一步失败都不影响主流程。
   */
  private async prepareMessages(messages: Message[]): Promise<PreparedMessages> {
    const recalled = await this.recallMemory(messages);
    const memoryNote = this.memory ? `memory_hits=${recalled.hitCount}` : '';

    let contextNote: string;
    let fitted: Message[] = recalled.messages;
    let compact: PreparedMessages['compact'];
    try {
      const fit = await this.context.fit(recalled.messages);
      const { stats } = fit;
      fitted = fit.messages;
      const changed =
        stats.layer1Trimmed > 0 || stats.layer2Compressed > 0 || stats.layer3Fallback > 0;
      compact = {
        stats,
        notes: [...fit.notes],
        dropped: Math.max(0, recalled.messages.length - fitted.length),
        changed,
      };
      const head = changed
        ? `context: layer1=${stats.layer1Trimmed} layer2=${stats.layer2Compressed} layer3=${stats.layer3Fallback} chars ${stats.charsBefore}->${stats.charsAfter} tokens≈${stats.estimatedTokens}`
        : `context: 未压缩 chars=${stats.charsBefore} tokens≈${stats.estimatedTokens}`;
      const detail = fit.notes.length > 0 ? `（${fit.notes.join('；')}）` : '';
      contextNote = summarize(`${head}${detail}`, 400);
    } catch (error) {
      contextNote = `context: fit 失败，使用原始消息（${errorMessage(error)}）`;
    }

    const note = memoryNote === '' ? contextNote : `${contextNote}；${memoryNote}`;
    return {
      messages: fitted,
      note: summarize(note, 500),
      memoryHits: recalled.hitCount,
      memoryQuery: recalled.query,
      memorySummary: recalled.injected,
      ...(compact ? { compact } : {}),
    };
  }

  /** 用最后一条 user 消息召回记忆，拼成一条 system 消息插在 system 前缀之后 */
  private async recallMemory(
    messages: Message[],
  ): Promise<{ messages: Message[]; hitCount: number; query: string; injected: string }> {
    const withoutMemory = messages.filter(
      (message) => !(message.role === 'system' && (message.content ?? '').startsWith(MEMORY_MARKER)),
    );
    const lastUser = [...withoutMemory].reverse().find((message) => message.role === 'user');
    const query = lastUser?.content ?? '';
    const memory = this.memory;
    if (!memory) return { messages: withoutMemory, hitCount: 0, query, injected: '' };
    if (!lastUser) return { messages: withoutMemory, hitCount: 0, query, injected: '' };

    let hits;
    try {
      hits = await memory.search(lastUser.content, { topK: this.memoryTopK });
    } catch {
      return { messages: withoutMemory, hitCount: 0, query, injected: '' };
    }
    if (hits.length === 0) return { messages: withoutMemory, hitCount: 0, query, injected: '' };

    let insertAt = 0;
    while (insertAt < withoutMemory.length && withoutMemory[insertAt]!.role === 'system') insertAt += 1;
    const injected = formatMemoryForPrompt(hits);
    const memoryMessage: Message = {
      role: 'system',
      content: injected,
      createdAt: Date.now(),
    };
    return {
      messages: [...withoutMemory.slice(0, insertAt), memoryMessage, ...withoutMemory.slice(insertAt)],
      hitCount: hits.length,
      query,
      injected,
    };
  }

  /** 正常结束（stopReason=final）时把本轮目标与结论写进记忆，失败静默 */
  private async rememberDecision(userInput: string, answer: string): Promise<void> {
    const memory = this.memory;
    if (!memory) return;
    try {
      await memory.append({
        text: `用户目标：${summarize(userInput, 120)}；结论：${summarize(answer, 200)}`,
        kind: 'decision',
        tag: 'session',
      });
    } catch {
      // 记忆写入失败不影响本次对话结果
    }
  }

  /** 工具请求快照：解析沙箱内绝对路径后交给 sink；不支持快照或失败时返回 undefined */
  private async captureSnapshot(sink: TraceSink, relative: string): Promise<ToolSnapshot | undefined> {
    if (!sink.snapshot) return undefined;
    try {
      const target = resolveSafePath(relative, this.rootDir);
      return await sink.snapshot(target.absolute, target.relative);
    } catch {
      return undefined;
    }
  }

  /**
   * 工具执行（带重试）：
   * - 只重试 classifyToolError 判为 retryable 的失败；
   * - 每次失败/重试写一条 kind=tool 的失败 trace（note 带 attempt 与分类）；
   * - 重试耗尽后返回 TOOL_RETRY_EXHAUSTED 回执；确定性失败原样返回；
   * - 结构化事件：一次逻辑调用发一条 tool.call，结束时发一条 tool.result（失败再补 error）。
   */
  private async executeToolWithRetry(
    call: { id: string; name: string; arguments: string },
    turn: number,
    record: RecordTrace,
    emit: TraceEmit,
    sink: TraceSink | undefined,
    sessionId: string | undefined,
    stats: MutableStats,
  ): Promise<ToolOutcome> {
    const maxAttempts = Math.max(1, Math.floor(this.retryOptions.maxAttempts ?? 3));
    const traceSession = sessionId ? { sessionId } : {};
    const memory = this.memory;
    const toolOptions = {
      ...(sessionId ? { sessionId } : {}),
      ...(memory ? { memory } : {}),
      ...(this.rootDir ? { rootDir: this.rootDir } : {}),
      ...(sink?.snapshot
        ? { snapshot: (relative: string) => this.captureSnapshot(sink, relative) }
        : {}),
      traceEvent: (draft: TraceEventDraft) => emit(draft, turn),
    };

    emit(
      {
        type: 'tool.call',
        toolName: call.name,
        arguments: call.arguments,
        toolCallId: call.id,
      },
      turn,
    );

    let attempts = 0;
    let lastResult: ToolResult | undefined;
    let lastClassification: ErrorClassification = { kind: 'fatal', reason: '未知工具错误' };

    try {
      const result = await withRetry(
        async (attempt) => {
          attempts = attempt;
          const toolResult = await this.registry.run(call.name, call.arguments, toolOptions);
          if (toolResult.ok) return toolResult;
          const classification = classifyToolError(toolResult);
          throw new ToolExecutionError(toolResult, classification);
        },
        {
          ...this.retryOptions,
          maxAttempts,
          shouldRetry: (error) =>
            error instanceof ToolExecutionError && error.classification.kind === 'retryable',
          onAttempt: (attempt, error, delayMs) => {
            const toolError = error instanceof ToolExecutionError ? error : undefined;
            const classification = toolError?.classification ?? classifyThrown(error);
            const failedResult = toolError?.result;
            lastClassification = classification;
            lastResult = failedResult;
            if (delayMs > 0) {
              stats.toolRetries += 1;
              this.usage.recordRetry();
            }
            record({
              turn,
              kind: 'tool',
              toolName: call.name,
              args: call.arguments,
              ok: false,
              resultSummary: summarize(failedResult?.output ?? errorMessage(error)),
              durationMs: failedResult?.durationMs ?? 0,
              note: [
                `attempt ${attempt}/${maxAttempts}`,
                `分类=${classification.kind}（${classification.reason}）`,
                delayMs > 0 ? `等待 ${delayMs}ms 后重试` : '不再重试',
              ].join('；'),
              ...traceSession,
            });
          },
        },
      );

      record({
        turn,
        kind: 'tool',
        toolName: call.name,
        args: call.arguments,
        ok: true,
        resultSummary: summarize(result.output),
        durationMs: result.durationMs ?? 0,
        ...(attempts > 1 ? { note: `第 ${attempts} 次尝试成功（已重试 ${attempts - 1} 次）` } : {}),
        ...traceSession,
      });
      emit(
        {
          type: 'tool.result',
          toolName: call.name,
          ok: true,
          durationMs: result.durationMs ?? 0,
          attempts,
          ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
          output: summarize(result.output),
        },
        turn,
      );
      return { result, attempts, classification: { kind: 'fatal', reason: '执行成功' } };
    } catch (error) {
      const retryError = error instanceof RetryError ? error : undefined;
      const actualAttempts = Math.max(1, retryError?.attempts ?? attempts);
      const root = retryError?.lastError ?? error;
      const classification = root instanceof ToolExecutionError ? root.classification : lastClassification;
      const rootResult = root instanceof ToolExecutionError ? root.result : lastResult;

      const fallback =
        classification.kind === 'retryable'
          ? buildToolFailureReceipt(call.name, rootResult, classification, actualAttempts)
          : rootResult ?? {
              ok: false,
              output: errorMessage(root),
              error: errorMessage(root),
            };

      emit(
        {
          type: 'tool.result',
          toolName: call.name,
          ok: false,
          durationMs: fallback.durationMs ?? 0,
          attempts: actualAttempts,
          ...(fallback.error ? { error: fallback.error } : {}),
          retryable: fallback.retryable ?? classification.kind === 'retryable',
          output: summarize(fallback.output),
        },
        turn,
      );
      emit(
        {
          type: 'error',
          scope: 'tool',
          kind: classification.kind,
          reason: classification.reason,
          message: summarize(fallback.output, 300),
        },
        turn,
      );

      return { result: fallback, attempts: actualAttempts, classification };
    }
  }

  /**
   * 模型调用（带重试）：
   * - 429 / 408 / 5xx / 网络 / 超时 -> 退避重试，Retry-After 优先；
   * - 400/401/403/404/413/422 -> 不重试，判 model_error；
   * - 402 / insufficient_quota / billing -> 不重试，判 quota_exhausted。
   */
  private async callModel(
    messages: Message[],
    tools: ToolSpec[] | undefined,
    turn: number,
    preparedNote: string,
    record: RecordTrace,
    emit: TraceEmit,
    sessionId: string | undefined,
    stats: MutableStats,
  ): Promise<ModelCallOutcome> {
    const maxAttempts = Math.max(1, Math.floor(this.retryOptions.maxAttempts ?? 3));
    const traceSession = sessionId ? { sessionId } : {};
    let attempts = 0;
    let lastAttemptDuration = 0;

    try {
      const response = await withRetry(
        async (attempt) => {
          attempts = attempt;
          const startedAt = Date.now();
          try {
            return await this.model.chat(messages, tools);
          } finally {
            lastAttemptDuration = Date.now() - startedAt;
          }
        },
        {
          ...this.retryOptions,
          maxAttempts,
          shouldRetry: (error) => classifyModelError(error).kind === 'retryable',
          onAttempt: (attempt, error, delayMs) => {
            const classification = classifyModelError(error);
            stats.modelRetries += delayMs > 0 ? 1 : 0;
            this.usage.recordFailure();
            if (delayMs > 0) this.usage.recordRetry();
            const retryAfter =
              classification.retryAfterMs !== undefined
                ? `；Retry-After=${classification.retryAfterMs}ms（实际等待 ${delayMs}ms）`
                : '';
            record({
              turn,
              kind: 'model',
              ok: false,
              durationMs: lastAttemptDuration,
              resultSummary: summarize(`${preparedNote}；模型调用失败：${errorMessage(error)}`),
              note: [
                `模型调用失败（attempt ${attempt}/${maxAttempts}，分类=${classification.kind}；${classification.reason}）`,
                delayMs > 0 ? `等待 ${delayMs}ms 后重试` : '不再重试',
                retryAfter.replace(/^；/, ''),
              ]
                .filter((part) => part !== '')
                .join('；'),
              ...traceSession,
            });
            emit(
              {
                type: 'model.retry',
                attempt,
                maxAttempts,
                delayMs,
                kind: classification.kind,
                reason: classification.reason,
              },
              turn,
            );
          },
        },
      );

      this.usage.recordUsage(response.usage);
      stats.modelCalls += 1;
      return { ok: true, response, attempts, durationMs: lastAttemptDuration };
    } catch (error) {
      const retryError = error instanceof RetryError ? error : undefined;
      const root = retryError?.lastError ?? error;
      const classification = classifyModelError(root);
      const actualAttempts = Math.max(1, retryError?.attempts ?? attempts);
      const stopReason: ModelCallFailure['stopReason'] =
        classification.kind === 'quota'
          ? 'quota_exhausted'
          : classification.kind === 'retryable'
            ? 'retry_exhausted'
            : 'model_error';
      return {
        ok: false,
        classification,
        attempts: actualAttempts,
        error: root,
        stopReason,
      };
    }
  }

  /** 把模型调用失败翻译成用户可见的中文文案（不含堆栈、路径与密钥） */
  private modelFailureAnswer(failure: ModelCallFailure): string {
    const { classification, attempts, error } = failure;
    if (classification.kind === 'quota') return QUOTA_ANSWER;
    if (classification.kind === 'retryable') {
      return (
        `调用模型失败，已重试 ${attempts} 次（原因：${classification.kind}/${classification.reason}）。` +
        `可以稍后重试，或检查 LLM_BASE_URL 是否可达。（最后错误：${errorMessage(error)}）`
      );
    }
    return (
      `模型调用失败，本次已停止（原因：${classification.kind} / ${classification.reason}）：` +
      `${errorMessage(error)}。请检查 .env 中的 LLM_BASE_URL、LLM_API_KEY 与 LLM_MODEL。`
    );
  }

  /** 执行一次完整的用户请求，返回最终答案 + trace + 消息序列 */
  async run(userInput: string, options: RunOptions = {}): Promise<LoopResult> {
    // 优先级：run options > 构造参数 > 'default'。
    // 但 'default' 只在配了 sessions 时兜底；没配 sessions 时保持 undefined，
    // 让 trace 字段与单会话版本完全一致。
    const sessionId =
      options.sessionId ?? this.defaultSessionId ?? (this.sessions ? DEFAULT_SESSION_ID : undefined);

    const trace: TraceEntry[] = [];
    const record = (entry: TraceEntry): void => {
      trace.push(entry);
      if (!this.logger) return;
      try {
        this.logger(entry);
      } catch {
        // logger 自身出错不影响 agent 主流程
      }
    };

    // 结构化事件：run 级 sink > 构造参数；没有 sink 时 emit 是空操作。
    // seq 在本次 run 内从 1 递增，ts 用发出时刻，turn 由调用方给（非轮次事件为 0）。
    const sink = options.traceSink ?? this.traceSink;
    let seq = 0;
    const emit: TraceEmit = (draft, turn = 0) => {
      if (!sink) return;
      seq += 1;
      try {
        // 落盘失败只降级：不影响对话本身，也不往 TraceEntry 里塞噪音
        void Promise.resolve(sink.emit(stampEvent(draft, seq, turn))).catch(() => {});
      } catch {
        // 同上
      }
    };

    // 历史来源：显式传入 > SessionStore 读盘 > 构造参数
    let history: Message[];
    if (options.history) {
      history = options.history;
    } else if (this.sessions && sessionId) {
      try {
        history = (await this.sessions.load(sessionId)).messages;
      } catch (error) {
        history = [];
        record({
          turn: 1,
          kind: 'error',
          ok: false,
          durationMs: 0,
          resultSummary: summarize(`会话历史读取失败：${errorMessage(error)}`),
          note: `session 读取失败（${sessionId}）：${errorMessage(error)}，本次按无历史处理`,
          ...(sessionId ? { sessionId } : {}),
        });
        emit(
          {
            type: 'error',
            scope: 'session',
            kind: 'fatal',
            reason: '会话历史读取失败，本次按无历史处理',
            message: summarize(errorMessage(error), 300),
          },
          1,
        );
      }
    } else {
      history = this.defaultHistory;
    }

    const messages: Message[] = [];
    if (this.systemPrompt.trim() !== '') {
      messages.push({ role: 'system', content: this.systemPrompt, createdAt: Date.now() });
    }
    messages.push(...history);
    messages.push({ role: 'user', content: userInput, createdAt: Date.now() });

    const tools = this.registry.list();
    const toolList = tools.length > 0 ? tools : undefined;
    const traceSession = sessionId ? { sessionId } : {};
    const stats: MutableStats = {
      modelCalls: 0,
      modelRetries: 0,
      toolCalls: 0,
      toolFailures: 0,
      toolRetries: 0,
    };

    emit({
      type: 'run.start',
      input: userInput,
      model: this.modelName,
      sandboxRoot: resolveRoot(this.rootDir),
      systemPrompt: summarize(this.systemPrompt, 200),
    });

    /** 统一出口：追加用量汇总 trace、发 run.end 事件、落盘会话与 trace、返回结果 */
    const finish = async (turn: number, stopReason: StopReason, answer: string): Promise<LoopResult> => {
      const usageNote = `用量汇总：${this.usage.summary()}`;
      record({
        turn,
        kind: 'final',
        ok: stopReason === 'final',
        durationMs: 0,
        resultSummary: summarize(usageNote),
        note: usageNote,
        ...traceSession,
      });
      emit(
        {
          type: 'run.end',
          stopReason,
          turns: turn,
          usage: this.usage.snapshot(),
          usageSummary: usageNote,
        },
        turn,
      );
      await this.usage.flush();
      // 任何终止原因（含 error / 熔断）都把本轮消息写回会话；失败只记 trace
      if (this.sessions && sessionId) {
        try {
          await this.sessions.save(
            sessionId,
            messages.filter((message) => message.role !== 'system'),
          );
        } catch (error) {
          record({
            turn,
            kind: 'error',
            ok: false,
            durationMs: 0,
            resultSummary: summarize(`会话保存失败：${errorMessage(error)}`),
            note: `session 保存失败（${sessionId}）：${errorMessage(error)}`,
            ...traceSession,
          });
          emit(
            {
              type: 'error',
              scope: 'session',
              kind: 'fatal',
              reason: '会话保存失败，本轮历史未落盘',
              message: summarize(errorMessage(error), 300),
            },
            turn,
          );
        }
      }
      // 末尾追加完整消息序列（复现用）；写失败同样只降级
      if (sink?.finalize) {
        try {
          await sink.finalize(messages);
        } catch {
          // trace 落盘失败不影响对话结果
        }
      }
      return {
        answer,
        stopReason,
        turns: turn,
        trace,
        messages,
        stats: { ...stats, usage: this.usage.snapshot() },
      };
    };

    for (let turn = 1; turn <= this.maxTurns; turn += 1) {
      // 第 0 步：下一次调模型前检查预算
      if (this.usage.isOverBudget()) {
        const snapshot = this.usage.snapshot();
        const answer =
          `本次已停止：累计用量 ${snapshot.totalTokens} tokens 已达到预算上限 ${snapshot.budgetTokens}` +
          `（prompt=${snapshot.promptTokens}，completion=${snapshot.completionTokens}）。` +
          '请调整 AGENT_BUDGET_TOKENS 或更换额度更充足的 key。';
        record({
          turn,
          kind: 'final',
          ok: false,
          durationMs: 0,
          resultSummary: summarize(answer),
          note: 'quota_exhausted: budget',
          ...traceSession,
        });
        return finish(turn, 'quota_exhausted', answer);
      }

      // 第 0.5 步：调模型前先做上下文压缩（三层，见 context.ts）
      const prepared = await this.prepareMessages(messages);

      // 记忆注入 / 上下文压缩各发一条结构化事件（不改变 prompt 拼接方式）
      if (this.memory) {
        emit(
          {
            type: 'memory.inject',
            hitCount: prepared.memoryHits,
            query: prepared.memoryQuery,
            summary:
              prepared.memorySummary === ''
                ? '（未命中，未注入）'
                : summarize(prepared.memorySummary, 300),
          },
          turn,
        );
      }
      if (prepared.compact?.changed) {
        const { stats: compactStats, notes, dropped } = prepared.compact;
        emit(
          {
            type: 'context.compact',
            layers: {
              layer1: compactStats.layer1Trimmed,
              layer2: compactStats.layer2Compressed,
              layer3: compactStats.layer3Fallback,
            },
            charsBefore: compactStats.charsBefore,
            charsAfter: compactStats.charsAfter,
            estimatedTokens: compactStats.estimatedTokens,
            dropped,
            notes,
          },
          turn,
        );
      }

      // 第 1 步：请求模型（带重试）
      const outcome = await this.callModel(
        prepared.messages,
        toolList,
        turn,
        prepared.note,
        record,
        emit,
        sessionId,
        stats,
      );

      if (!outcome.ok) {
        const answer = this.modelFailureAnswer(outcome);
        emit(
          {
            type: 'error',
            scope: 'model',
            kind: outcome.classification.kind,
            reason: outcome.classification.reason,
            message: summarize(errorMessage(outcome.error), 300),
          },
          turn,
        );
        record({
          turn,
          kind: 'final',
          ok: false,
          durationMs: 0,
          resultSummary: summarize(answer),
          note: outcome.stopReason,
          ...traceSession,
        });
        return finish(turn, outcome.stopReason, answer);
      }

      const response = outcome.response;
      const toolCalls = response.toolCalls ?? [];
      const usage: Usage | undefined = response.usage;

      record({
        turn,
        kind: 'model',
        ok: true,
        durationMs: outcome.durationMs,
        resultSummary: summarize(
          toolCalls.length > 0
            ? `发起 ${toolCalls.length} 次工具调用：${toolCalls.map((call) => call.name).join(', ')}`
            : response.content,
        ),
        ...(usage ? { usage } : {}),
        note:
          outcome.attempts > 1
            ? `${prepared.note}；第 ${outcome.attempts} 次尝试成功（已重试 ${outcome.attempts - 1} 次）`
            : prepared.note,
        ...traceSession,
      });
      emit(
        {
          type: 'model.reply',
          content: response.content ?? '',
          toolCalls: toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: summarize(call.arguments, 200),
          })),
          ...(usage ? { usage } : {}),
          durationMs: outcome.durationMs,
          attempts: outcome.attempts,
          compressed: prepared.compact?.changed ?? false,
          memoryHits: prepared.memoryHits,
        },
        turn,
      );

      // 第 2 步：记录 assistant 消息（可能包含 tool_calls）
      const assistantMessage: Message = {
        role: 'assistant',
        content: response.content ?? '',
        createdAt: Date.now(),
      };
      if (toolCalls.length > 0) {
        assistantMessage.toolCalls = toolCalls;
      }
      messages.push(assistantMessage);

      // 纯对话：一轮直接返回
      if (toolCalls.length === 0) {
        const answer = (response.content ?? '').trim();
        record({
          turn,
          kind: 'final',
          ok: true,
          durationMs: 0,
          resultSummary: summarize(answer),
          note: 'final',
          ...traceSession,
        });
        // 正常结束：把本轮目标与结论写入记忆（去重），失败静默
        await this.rememberDecision(userInput, answer);
        return finish(turn, 'final', answer);
      }

      // 第 3 步：执行工具（串行，保证结果顺序与 tool_calls 一致）
      let circuit:
        | { toolName: string; classification: ErrorClassification; attempts: number; streak: number }
        | undefined;

      for (const call of toolCalls) {
        stats.toolCalls += 1;
        const toolOutcome = await this.executeToolWithRetry(
          call,
          turn,
          record,
          emit,
          sink,
          sessionId,
          stats,
        );
        const streakKey = `${sessionId ?? ''}::${call.name}`;

        if (toolOutcome.result.ok) {
          this.failureStreaks.delete(streakKey);
        } else {
          stats.toolFailures += 1;
          const streak = (this.failureStreaks.get(streakKey) ?? 0) + 1;
          this.failureStreaks.set(streakKey, streak);
          if (streak >= this.toolFailureThreshold) {
            circuit = {
              toolName: call.name,
              classification: toolOutcome.classification,
              attempts: toolOutcome.attempts,
              streak,
            };
          }
        }

        // 第 4 步：结果回灌，进入下一轮
        messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: toolMessageContent(
            toolOutcome.result.ok,
            toolOutcome.result.output,
            toolOutcome.result.error,
          ),
          createdAt: Date.now(),
        });

        if (circuit) break;
      }

      if (circuit) {
        const retryText =
          circuit.attempts > 1 ? `已重试 ${circuit.attempts - 1} 次` : '未重试（确定性失败）';
        const answer = [
          `同一工具连续失败 ${circuit.streak} 次，已触发熔断并终止本次任务。`,
          `工具：${circuit.toolName}`,
          `最近失败分类：${circuit.classification.kind}（${circuit.classification.reason}）`,
          `重试情况：${retryText}`,
          '建议：检查该工具的参数或上游状态，稍后重试；也可以换个说法或换用其它工具。',
        ].join('\n');
        record({
          turn,
          kind: 'final',
          ok: false,
          durationMs: 0,
          resultSummary: summarize(answer),
          note: 'tool_failure',
          ...traceSession,
        });
        return finish(turn, 'tool_failure', answer);
      }
    }

    // 超出轮次上限：给出明确终止原因，并附最后一轮工具结果摘要
    const lastToolMessages = messages
      .filter((message) => message.role === 'tool')
      .slice(-3)
      .map((message) => summarize(message.content, 120));
    const answer = [
      `已达到最大轮次上限（maxTurns=${this.maxTurns}），本次任务终止。`,
      lastToolMessages.length > 0 ? `最后几轮工具结果：${lastToolMessages.join(' | ')}` : '',
    ]
      .filter((part) => part !== '')
      .join('\n');

    record({
      turn: this.maxTurns,
      kind: 'final',
      ok: false,
      durationMs: 0,
      resultSummary: summarize(answer),
      note: 'max_turns',
      ...traceSession,
    });

    return finish(this.maxTurns, 'max_turns', answer);
  }
}

/** 便捷工厂 */
export function createAgentLoop(options: AgentLoopOptions): AgentLoop {
  return new AgentLoop(options);
}
