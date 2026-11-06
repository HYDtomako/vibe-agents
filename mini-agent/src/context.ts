/**
 * Context Engineering：三层上下文压缩。
 *
 * 每轮调模型前调用一次 fit(messages, opts)，返回「实际发给模型的消息」+ 统计 + 说明。
 * 三层各自独立、条件触发：
 *
 *   第 1 层（每轮都跑，只降载不删消息）
 *     - 最近 3 轮原样保留；更老的 tool 消息 content 做「首 600 + 尾 300 + …[已裁剪 N 字符]」
 *       （低于 1200 字符不动）；
 *     - 老 assistant 的 toolCalls.arguments 超过 400 字符时截成 head 200 + …[参数已裁剪]，
 *       保留 toolCallId 与 name，保证 assistant/tool 配对不坏。
 *
 *   第 2 层（任一阈值命中才触发：消息数 > 40、估算 token > 12000、轮次 > 15）
 *     - system + 最近 6 轮原样保留，中间段交给注入的 ModelClient 压成一条 `[历史摘要]` 消息；
 *     - 已存在的 `[历史摘要]` 与其后新增中段一起重新压，不重复堆叠；
 *     - 摘要器抛错 / 超时（默认 15s）/ 返回空 / 摘要不比原中段短时，转入第 3 层。
 *
 *   第 3 层（兜底，绝不抛异常）
 *     - 不再调模型：保留 system + 已有 `[历史摘要]`（没有就写一条硬摘要，记录丢弃条数与首末消息时间）
 *       + 最近 12 轮，其余丢弃；
 *     - fit 之后仍超 MAX_TOKENS 时，从老到新继续整轮丢弃，保底 system + 最近 2 轮。
 *
 * token 是**估算**：ASCII 按 4 字符 ≈ 1 token，CJK 等宽字符按 1 字 ≈ 1 token，
 * 每条消息再加固定开销。只用于触发阈值与报告节省量，不等于服务端计费口径。
 */

import type { Message, ModelClient } from './types.js';

/** 摘要消息标记；同一时间最多存在一条 */
export const SUMMARY_MARKER = '[历史摘要]';
/** 记忆注入消息标记（由 loop 在 fit 之前插入，三层压缩都必须保留它） */
export const MEMORY_MARKER = '[相关记忆]';
/** 裁剪标记：用于识别「已经裁过」，避免重复裁剪吃掉标记 */
const CLIP_MARKER = '…[已裁剪';
const ARGS_CLIP_MARKER = '…[参数已裁剪]';

export interface ContextStats {
  /** 第 1 层裁剪的条目数（一条 tool 消息或一组 toolCalls 计 1） */
  layer1Trimmed: number;
  /** 第 2 层被压成摘要的中段消息条数（0 表示未触发） */
  layer2Compressed: number;
  /** 第 3 层兜底是否触发（1 表示触发过） */
  layer3Fallback: number;
  charsBefore: number;
  charsAfter: number;
  /** 压缩后消息序列的 token 估算值 */
  estimatedTokens: number;
}

export interface FitOptions {
  /** 轮次；缺省按 user 消息条数推断 */
  turnCount?: number;
}

export interface FitResult {
  messages: Message[];
  stats: ContextStats;
  /** 人可读的说明：哪一层生效、失败原因、丢弃了多少 */
  notes: string[];
}

export interface ContextEngineOptions {
  /** 摘要器（第 2 层用）；测试可注入假实现 */
  summarizer: ModelClient;
  /** 第 1 层保留的最近轮数，默认 3 */
  keepRecentTurnsLayer1?: number;
  /** tool 消息裁剪阈值，默认 1200 字符 */
  toolTrimThreshold?: number;
  /** 裁剪后保留的开头字符数，默认 600 */
  toolHeadChars?: number;
  /** 裁剪后保留的结尾字符数，默认 300 */
  toolTailChars?: number;
  /** toolCalls.arguments 裁剪阈值，默认 400 字符 */
  toolArgsLimit?: number;
  /** 参数裁剪后保留的开头字符数，默认 200 */
  toolArgsHead?: number;
  /** 第 2 层触发：消息数阈值，默认 40 */
  maxMessages?: number;
  /** 第 2 层触发：token 估算阈值，默认 12000 */
  maxTokens?: number;
  /** 第 2 层触发：轮次阈值，默认 15 */
  maxTurns?: number;
  /** 第 2 层保留的最近轮数，默认 6 */
  keepRecentTurnsLayer2?: number;
  /** 第 3 层保留的最近轮数，默认 12 */
  keepRecentTurnsFallback?: number;
  /** 预算兜底时最少保留的轮数，默认 2 */
  minKeepTurns?: number;
  /** 摘要器超时，默认 15000ms */
  summaryTimeoutMs?: number;
}

/** 轻量 token 估算：ASCII/4 + CJK 1 字 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / 4) + wide;
}

/** 估算一组消息的 token 数（含每条消息的固定开销） */
export function estimateMessagesTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += 4 + estimateTokens(message.content ?? '');
    for (const call of message.toolCalls ?? []) {
      total += 6 + estimateTokens(call.name) + estimateTokens(call.arguments);
    }
  }
  return total;
}

/** 统计消息序列的字符数（content + 工具名 + 参数） */
export function countChars(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += (message.content ?? '').length;
    for (const call of message.toolCalls ?? []) {
      total += call.name.length + call.arguments.length;
    }
  }
  return total;
}

/**
 * 把消息切成「前缀 + 若干轮」。
 * 前缀 = 开头连续的 system 消息（含 loop 注入的 `[相关记忆]`），三层压缩都不会丢弃它。
 */
export function splitTurns(messages: readonly Message[]): { prefix: Message[]; groups: Message[][] } {
  const prefix: Message[] = [];
  let index = 0;
  while (index < messages.length && messages[index]!.role === 'system') {
    prefix.push(messages[index]!);
    index += 1;
  }

  const groups: Message[][] = [];
  let current: Message[] | null = null;
  for (; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === 'user') {
      if (current) groups.push(current);
      current = [message];
      continue;
    }
    if (!current) current = [];
    current.push(message);
  }
  if (current) groups.push(current);
  return { prefix, groups };
}

/** 轮次 = user 消息条数（至少 1，便于只有 system+assistant 的场景） */
export function countTurns(messages: readonly Message[]): number {
  const users = messages.filter((message) => message.role === 'user').length;
  return users > 0 ? users : 1;
}

function isSummaryMessage(message: Message): boolean {
  return message.role === 'assistant' && (message.content ?? '').startsWith(SUMMARY_MARKER);
}

function formatTime(timestamp: number | undefined): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '时间未知';
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export class ContextEngine {
  private readonly summarizer: ModelClient;
  private readonly keepRecentTurnsLayer1: number;
  private readonly toolTrimThreshold: number;
  private readonly toolHeadChars: number;
  private readonly toolTailChars: number;
  private readonly toolArgsLimit: number;
  private readonly toolArgsHead: number;
  private readonly maxMessages: number;
  private readonly maxTokens: number;
  private readonly maxTurns: number;
  private readonly keepRecentTurnsLayer2: number;
  private readonly keepRecentTurnsFallback: number;
  private readonly minKeepTurns: number;
  private readonly summaryTimeoutMs: number;

  constructor(options: ContextEngineOptions) {
    if (!options || !options.summarizer) throw new Error('ContextEngine 需要 summarizer（用于第 2 层摘要）');
    this.summarizer = options.summarizer;
    this.keepRecentTurnsLayer1 = Math.max(0, options.keepRecentTurnsLayer1 ?? 3);
    this.toolTrimThreshold = options.toolTrimThreshold ?? 1200;
    this.toolHeadChars = options.toolHeadChars ?? 600;
    this.toolTailChars = options.toolTailChars ?? 300;
    this.toolArgsLimit = options.toolArgsLimit ?? 400;
    this.toolArgsHead = options.toolArgsHead ?? 200;
    this.maxMessages = options.maxMessages ?? 40;
    this.maxTokens = options.maxTokens ?? 12_000;
    this.maxTurns = options.maxTurns ?? 15;
    this.keepRecentTurnsLayer2 = options.keepRecentTurnsLayer2 ?? 6;
    this.keepRecentTurnsFallback = options.keepRecentTurnsFallback ?? 12;
    this.minKeepTurns = options.minKeepTurns ?? 2;
    this.summaryTimeoutMs = options.summaryTimeoutMs ?? 15_000;
  }

  /** 对一次模型调用前的消息序列做压缩 */
  async fit(messages: readonly Message[], options: FitOptions = {}): Promise<FitResult> {
    const notes: string[] = [];
    const stats: ContextStats = {
      layer1Trimmed: 0,
      layer2Compressed: 0,
      layer3Fallback: 0,
      charsBefore: countChars(messages),
      charsAfter: 0,
      estimatedTokens: 0,
    };

    let working = this.applyLayer1([...messages], stats);

    const turnCount = options.turnCount ?? countTurns(working);
    const tokens = estimateMessagesTokens(working);
    if (working.length > this.maxMessages || tokens > this.maxTokens || turnCount > this.maxTurns) {
      notes.push(
        `layer2 触发：消息数 ${working.length}/${this.maxMessages}、估算 token ${tokens}/${this.maxTokens}、轮次 ${turnCount}/${this.maxTurns}`,
      );
      working = await this.compress(working, stats, notes);
    }

    if (estimateMessagesTokens(working) > this.maxTokens) {
      working = this.dropToBudget(working, stats, notes);
    }

    stats.charsAfter = countChars(working);
    stats.estimatedTokens = estimateMessagesTokens(working);
    return { messages: working, stats, notes };
  }

  // ---------- 第 1 层 ----------

  private applyLayer1(messages: Message[], stats: ContextStats): Message[] {
    const { prefix, groups } = splitTurns(messages);
    const cutoff = Math.max(0, groups.length - this.keepRecentTurnsLayer1);

    const result: Message[] = [...prefix];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]!;
      if (index >= cutoff) {
        result.push(...group);
        continue;
      }
      for (const message of group) result.push(this.trimMessage(message, stats));
    }
    return result;
  }

  private trimMessage(message: Message, stats: ContextStats): Message {
    let changed = false;
    let content = message.content ?? '';

    if (message.role === 'tool' && content.length >= this.toolTrimThreshold && !content.includes(CLIP_MARKER)) {
      const removed = content.length - this.toolHeadChars - this.toolTailChars;
      if (removed > 0) {
        content = `${content.slice(0, this.toolHeadChars)}…[已裁剪 ${removed} 字符]${content.slice(content.length - this.toolTailChars)}`;
        stats.layer1Trimmed += 1;
        changed = true;
      }
    }

    let toolCalls = message.toolCalls;
    if (toolCalls && toolCalls.length > 0) {
      let callsChanged = false;
      toolCalls = toolCalls.map((call) => {
        if (call.arguments.length <= this.toolArgsLimit || call.arguments.includes(ARGS_CLIP_MARKER)) return call;
        callsChanged = true;
        return {
          id: call.id,
          name: call.name,
          arguments: `${call.arguments.slice(0, this.toolArgsHead)}${ARGS_CLIP_MARKER}`,
        };
      });
      if (callsChanged) {
        stats.layer1Trimmed += 1;
        changed = true;
      }
    }

    if (!changed) return message;
    return { ...message, content, ...(toolCalls ? { toolCalls } : {}) };
  }

  // ---------- 第 2 层 ----------

  private buildSummaryPrompt(transcript: string): string {
    return [
      '你是上下文压缩器。下面是一段较早的 agent 对话记录（可能已包含更早的摘要）。',
      '请用中文写一段不超过 400 字的摘要，必须覆盖以下四点：',
      '1) 用户的目标与约束；',
      '2) 已完成的关键动作及其结果（工具名 + 关键结论）；',
      '3) 仍未完成的待办；',
      '4) 关键事实、文件路径与数值。',
      '只输出摘要正文：不要标题、不要复述原文、不要调用工具。',
      '',
      '对话记录：',
      transcript,
    ].join('\n');
  }

  private renderTranscript(messages: readonly Message[]): string {
    const lines: string[] = [];
    for (const message of messages) {
      const role = message.role;
      const text = (message.content ?? '').trim();
      const clipped = text.length > 500 ? `${text.slice(0, 500)}…` : text;
      if (message.toolCalls && message.toolCalls.length > 0) {
        const calls = message.toolCalls.map((call) => `${call.name}(${call.arguments.slice(0, 200)})`).join('; ');
        lines.push(`[${role}] ${clipped} -> 调用 ${calls}`);
      } else {
        lines.push(`[${role}] ${clipped}`);
      }
    }
    return lines.join('\n');
  }

  private async withTimeout(promise: Promise<{ content: string }>): Promise<{ content: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`摘要器超时（${this.summaryTimeoutMs}ms）`)), this.summaryTimeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async compress(messages: Message[], stats: ContextStats, notes: string[]): Promise<Message[]> {
    const { prefix, groups } = splitTurns(messages);
    const keep = this.keepRecentTurnsLayer2;
    if (groups.length <= keep) {
      notes.push(`layer2 跳过：轮数 ${groups.length} 不超过保留的 ${keep} 轮，没有中段可压`);
      return messages;
    }

    const middle = groups.slice(0, groups.length - keep).flat();
    const recent = groups.slice(groups.length - keep).flat();
    const middleChars = countChars(middle);
    let reason = '';

    try {
      const response = await this.withTimeout(
        this.summarizer.chat([{ role: 'user', content: this.buildSummaryPrompt(this.renderTranscript(middle)) }]),
      );
      const content = (response.content ?? '').trim();
      if (content === '') throw new Error('摘要器返回空内容');
      if (content.length >= middleChars) {
        throw new Error(`摘要长度 ${content.length} 未小于原中段 ${middleChars} 字符`);
      }

      const summaryMessage: Message = {
        role: 'assistant',
        content: `${SUMMARY_MARKER} ${content}`,
        createdAt: Date.now(),
      };
      stats.layer2Compressed = middle.length;
      notes.push(`layer2 生效：${middle.length} 条中段消息压成 1 条摘要（${middleChars} -> ${content.length} 字符）`);
      return [...prefix, summaryMessage, ...recent];
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }

    return this.fallback(messages, stats, notes, reason);
  }

  // ---------- 第 3 层 ----------

  private fallback(messages: Message[], stats: ContextStats, notes: string[], reason: string): Message[] {
    stats.layer3Fallback = 1;
    try {
      const { prefix, groups } = splitTurns(messages);
      const keep = this.keepRecentTurnsFallback;
      const cut = Math.max(0, groups.length - keep);
      const dropped = groups.slice(0, cut).flat();
      const recent = groups.slice(cut).flat();

      if (dropped.length === 0) {
        notes.push(`layer3 兜底：摘要失败（${reason}），没有可丢弃的中段，原样返回`);
        return messages;
      }

      const existing = dropped.find(isSummaryMessage);
      let summary: Message;
      if (existing) {
        summary = existing;
        notes.push(`layer3 兜底：摘要失败（${reason}），保留已有 ${SUMMARY_MARKER} + 最近 ${keep} 轮`);
      } else {
        const first = dropped[0]?.createdAt;
        const last = dropped[dropped.length - 1]?.createdAt;
        summary = {
          role: 'assistant',
          content:
            `${SUMMARY_MARKER} 【兜底】摘要器不可用（${reason}），已丢弃 ${dropped.length} 条较早消息` +
            `（${formatTime(first)} ~ ${formatTime(last)}），仅保留最近 ${keep} 轮。`,
          createdAt: Date.now(),
        };
        notes.push(`layer3 兜底：摘要失败（${reason}），写入硬摘要并丢弃 ${dropped.length} 条较早消息`);
      }
      return [...prefix, summary, ...recent];
    } catch (error) {
      notes.push(`layer3 兜底自身出错（${error instanceof Error ? error.message : String(error)}），原样返回`);
      return messages;
    }
  }

  /** 仍超 token 预算时从老到新整轮丢弃，保底 system + 最近 minKeepTurns 轮 */
  private dropToBudget(messages: Message[], stats: ContextStats, notes: string[]): Message[] {
    const { prefix, groups } = splitTurns(messages);
    const min = Math.max(1, this.minKeepTurns);
    if (groups.length <= min) {
      notes.push(`预算兜底：只剩 ${groups.length} 轮，已到保底（system + 最近 ${min} 轮），无法继续丢弃`);
      return messages;
    }

    let cut = 0;
    while (cut < groups.length - min) {
      cut += 1;
      if (estimateMessagesTokens([...prefix, ...groups.slice(cut).flat()]) <= this.maxTokens) break;
    }

    if (cut === 0) return messages;

    const dropped = groups.slice(0, cut).flat();
    const kept = groups.slice(cut).flat();
    stats.layer3Fallback = 1;
    notes.push(
      `预算兜底：仍超 ${this.maxTokens} token，从最早消息起丢弃 ${dropped.length} 条，保留 ${groups.length - cut} 轮`,
    );
    return [...prefix, ...kept];
  }
}

/** 便捷工厂 */
export function createContextEngine(options: ContextEngineOptions): ContextEngine {
  return new ContextEngine(options);
}
