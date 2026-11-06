/**
 * 额度 / 用量记账。
 *
 * - 累计 prompt / completion / total tokens、调用次数、失败次数、重试次数；
 * - 支持 budgetTokens 上限：下一次调模型前检查，超过即由 loop 停止（quota_exhausted）；
 * - 可选落盘到 `.agent-usage.json`（CLI --usage 或 AGENT_USAGE_FILE 开启），
 *   文件内容是可直接 JSON.parse 的快照；
 * - 上游没给 usage / 缺字段时按 0 计，并记录 missingUsageCalls 供汇总说明。
 *
 * 只用 Node 标准库，不引入运行时依赖。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Usage, UsageSnapshot } from './types.js';

/** 默认落盘文件名（相对当前工作目录） */
export const DEFAULT_USAGE_FILE = '.agent-usage.json';

/** 开启落盘的环境变量：路径，或 1/true 表示默认文件 */
export const USAGE_ENV_KEY = 'AGENT_USAGE_FILE';

/** token 预算的环境变量 */
export const BUDGET_ENV_KEY = 'AGENT_BUDGET_TOKENS';

export interface UsageTrackerOptions {
  /** token 预算上限；不填表示不限制 */
  budgetTokens?: number;
  /** 落盘路径；不填表示只在内存中累计 */
  filePath?: string;
  /** 可注入时钟，便于测试 */
  now?: () => number;
}

/** 落盘文件的结构：version + updatedAt + 快照字段 */
export interface UsageFilePayload extends UsageSnapshot {
  version: 1;
  updatedAt: string;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

/** 读取 AGENT_USAGE_FILE：空值关闭；1/true 用默认文件；其它按路径 */
export function usageFilePathFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[USAGE_ENV_KEY]?.trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (lower === '0' || lower === 'false' || lower === 'off') return undefined;
  if (lower === '1' || lower === 'true' || lower === 'on') return DEFAULT_USAGE_FILE;
  return raw;
}

/** CLI 解析：--usage 或 AGENT_USAGE_FILE 任一开启即落盘 */
export function resolveUsageFile(
  options: { enabled?: boolean; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const fromEnv = usageFilePathFromEnv(options.env ?? process.env);
  if (fromEnv) return fromEnv;
  return options.enabled ? DEFAULT_USAGE_FILE : undefined;
}

/** 读取 AGENT_BUDGET_TOKENS；非法或非正数返回 undefined */
export function readBudgetTokens(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[BUDGET_ENV_KEY]?.trim();
  if (!raw) return undefined;
  return positiveInt(Number(raw));
}

export class UsageTracker {
  private promptTokens = 0;
  private completionTokens = 0;
  private totalTokens = 0;
  private calls = 0;
  private failures = 0;
  private retries = 0;
  private missingUsageCalls = 0;

  readonly budgetTokens: number | undefined;
  readonly filePath: string | undefined;
  private readonly now: () => number;
  private lastPersistError: unknown;

  constructor(options: UsageTrackerOptions = {}) {
    this.budgetTokens = positiveInt(options.budgetTokens);
    this.filePath = options.filePath && options.filePath.trim() !== '' ? options.filePath : undefined;
    this.now = options.now ?? Date.now;
  }

  /** 记录一次成功的模型响应；usage 缺失或字段缺失都按 0 计 */
  recordUsage(usage?: Usage | null): void {
    this.calls += 1;
    const prompt = typeof usage?.promptTokens === 'number' ? usage.promptTokens : 0;
    const completion = typeof usage?.completionTokens === 'number' ? usage.completionTokens : 0;
    const total = typeof usage?.totalTokens === 'number' ? usage.totalTokens : 0;

    this.promptTokens += Number.isFinite(prompt) ? prompt : 0;
    this.completionTokens += Number.isFinite(completion) ? completion : 0;
    this.totalTokens += Number.isFinite(total) ? total : 0;

    const missing =
      !usage ||
      typeof usage.promptTokens !== 'number' ||
      typeof usage.completionTokens !== 'number' ||
      typeof usage.totalTokens !== 'number';
    if (missing) this.missingUsageCalls += 1;
  }

  /** 记录一次模型调用失败（含重试中的失败尝试） */
  recordFailure(): void {
    this.failures += 1;
  }

  /** 记录一次重试（模型或工具） */
  recordRetry(count = 1): void {
    if (count > 0) this.retries += Math.floor(count);
  }

  /** 累计用量是否已达到/超过预算 */
  isOverBudget(): boolean {
    return this.budgetTokens !== undefined && this.totalTokens >= this.budgetTokens;
  }

  /** 距离预算还剩多少 token；未配置预算返回 undefined */
  remainingTokens(): number | undefined {
    if (this.budgetTokens === undefined) return undefined;
    return Math.max(0, this.budgetTokens - this.totalTokens);
  }

  snapshot(): UsageSnapshot {
    const snapshot: UsageSnapshot = {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
      calls: this.calls,
      failures: this.failures,
      retries: this.retries,
      missingUsageCalls: this.missingUsageCalls,
      overBudget: this.isOverBudget(),
    };
    if (this.budgetTokens !== undefined) snapshot.budgetTokens = this.budgetTokens;
    return snapshot;
  }

  /** trace / CLI 用的一行中文汇总 */
  summary(): string {
    const parts = [
      `total=${this.totalTokens}（prompt=${this.promptTokens} / completion=${this.completionTokens}）`,
      `调用 ${this.calls} 次`,
      `失败 ${this.failures} 次`,
      `重试 ${this.retries} 次`,
    ];
    if (this.budgetTokens !== undefined) {
      parts.push(`预算 ${this.budgetTokens}（剩余 ${this.remainingTokens()}）`);
    }
    if (this.missingUsageCalls > 0) {
      parts.push(`上游未给 usage 的调用 ${this.missingUsageCalls} 次（缺字段按 0 计）`);
    }
    return parts.join('，');
  }

  /** 清零内存累计（不删已落盘文件） */
  reset(): void {
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.totalTokens = 0;
    this.calls = 0;
    this.failures = 0;
    this.retries = 0;
    this.missingUsageCalls = 0;
  }

  /** 落盘快照；未配置 filePath 时为 no-op；失败只记录不外抛 */
  async flush(): Promise<void> {
    if (!this.filePath) return;
    const payload: UsageFilePayload = {
      version: 1,
      updatedAt: new Date(this.now()).toISOString(),
      ...this.snapshot(),
    };
    try {
      const directory = path.dirname(this.filePath);
      if (directory && directory !== '.') await mkdir(directory, { recursive: true });
      await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      this.lastPersistError = undefined;
    } catch (error) {
      this.lastPersistError = error;
    }
  }

  /** 最近一次落盘失败的原因（调试用） */
  get persistError(): unknown {
    return this.lastPersistError;
  }
}

/** 便捷工厂 */
export function createUsageTracker(options: UsageTrackerOptions = {}): UsageTracker {
  return new UsageTracker(options);
}
