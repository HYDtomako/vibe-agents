/**
 * 重试与退避：指数退避 + 抖动 + 尊重服务端 Retry-After。
 *
 * 设计要点：
 * - sleep / random / now 都可注入，测试用 recordingSleep 断言退避序列，不真等；
 * - Retry-After 优先于本地退避，但一律封顶 maxDelayMs，避免服务端给出离谱等待；
 * - deadlineMs 是「从第一次尝试开始算」的总耗时预算，超了就放弃；
 * - 每次失败都回调 onAttempt(attempt, error, delayMs)，最后一次不再重试时 delayMs=0，
 *   loop 用它写 trace（attempt + 分类 + 等待时长）。
 */

import { readRetryAfterMs } from './errors.js';

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface RetryOptions {
  /** 总尝试次数（含首次），默认 3 */
  maxAttempts?: number;
  /** 指数退避基数，默认 300ms */
  baseDelayMs?: number;
  /** 单次等待上限，默认 4000ms */
  maxDelayMs?: number;
  /** 是否加抖动（50%-100%），默认 true */
  jitter?: boolean;
  /** 判断某次失败是否值得重试；默认所有失败都重试 */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 从第一次尝试开始的总耗时预算（毫秒），超出即放弃 */
  deadlineMs?: number;
  /** 可注入的 sleep，测试用 */
  sleep?: SleepFn;
  /** 可注入的随机源，默认 Math.random */
  random?: () => number;
  /** 可注入的时钟，默认 Date.now */
  now?: () => number;
  /** 读取服务端 Retry-After；默认读 error.retryAfterMs / retryAfter / headers */
  retryAfterMs?: (error: unknown) => number | undefined;
  /** 每次失败后的回调（含最后一次失败，delayMs=0） */
  onAttempt?: (attempt: number, error: unknown, delayMs: number) => void | Promise<void>;
}

/** 重试失败原因：次数耗尽 / 不可重试 / 超时 / 取消 */
export type RetryStopReason = 'exhausted' | 'not_retryable' | 'deadline' | 'aborted';

/** withRetry 用尽后的错误，保留尝试次数与最后一次原始错误 */
export class RetryError extends Error {
  readonly attempts: number;
  readonly lastError: unknown;
  readonly delays: number[];
  readonly stopReason: RetryStopReason;

  constructor(
    message: string,
    attempts: number,
    lastError: unknown,
    delays: number[],
    stopReason: RetryStopReason,
  ) {
    super(message);
    this.name = 'RetryError';
    this.attempts = attempts;
    this.lastError = lastError;
    this.delays = [...delays];
    this.stopReason = stopReason;
  }
}

/** 把 Retry-After 响应头解析成毫秒：支持秒数与 HTTP 日期两种格式 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, Math.floor(seconds * 1000));

  const timestamp = Date.parse(trimmed);
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - now);
  return undefined;
}

/** 指数退避：base * 2^(attempt-1)，封顶 maxDelay，可选 50%-100% 抖动 */
export function computeBackoffDelay(
  attempt: number,
  options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'jitter' | 'random'> = {},
): number {
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 300);
  const maxDelayMs = Math.max(0, options.maxDelayMs ?? 4000);
  const exponent = Math.max(0, attempt - 1);
  const exponential = baseDelayMs * 2 ** exponent;
  const capped = Math.min(exponential, maxDelayMs);
  if (options.jitter === false || capped === 0) return Math.round(capped);

  const random = options.random ?? Math.random;
  const sample = Math.min(1, Math.max(0, random()));
  return Math.round(capped * (0.5 + 0.5 * sample));
}

/** 默认 sleep：可被 AbortSignal 中断 */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return signal?.aborted ? Promise.reject(new Error('已取消')) : Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    onAbort = () => {
      cleanup();
      reject(new Error('已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/**
 * 执行 fn，失败时按 shouldRetry 判断是否退避重试。
 * 成功返回 fn 的返回值；最终失败抛 RetryError（含 attempts / lastError / delays / stopReason）。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const maxDelayMs = Math.max(0, options.maxDelayMs ?? 4000);
  const jitter = options.jitter ?? true;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const readServerDelay = options.retryAfterMs ?? readRetryAfterMs;
  const startedAt = now();
  const delays: number[] = [];
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new RetryError('操作已取消，未执行', attempt - 1, lastError, delays, 'aborted');
    }

    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const policyRetry = options.shouldRetry ? options.shouldRetry(error, attempt) : true;

      if (!policyRetry) {
        await options.onAttempt?.(attempt, error, 0);
        throw new RetryError(
          `第 ${attempt} 次尝试失败，不再重试：${errorMessage(error)}`,
          attempt,
          error,
          delays,
          'not_retryable',
        );
      }

      if (attempt >= maxAttempts) {
        await options.onAttempt?.(attempt, error, 0);
        throw new RetryError(
          `已重试 ${Math.max(0, maxAttempts - 1)} 次仍失败：${errorMessage(error)}`,
          attempt,
          error,
          delays,
          'exhausted',
        );
      }

      const serverDelay = readServerDelay(error);
      const delayMs =
        serverDelay !== undefined
          ? Math.min(Math.max(0, serverDelay), maxDelayMs)
          : computeBackoffDelay(attempt, {
              baseDelayMs: options.baseDelayMs,
              maxDelayMs,
              jitter,
              random: options.random,
            });

      if (options.deadlineMs !== undefined && now() - startedAt + delayMs > options.deadlineMs) {
        await options.onAttempt?.(attempt, error, 0);
        throw new RetryError(
          `重试预算（${options.deadlineMs}ms）已耗尽，第 ${attempt} 次尝试失败：${errorMessage(error)}`,
          attempt,
          error,
          delays,
          'deadline',
        );
      }

      delays.push(delayMs);
      await options.onAttempt?.(attempt, error, delayMs);
      try {
        await sleep(delayMs, options.signal);
      } catch (sleepError) {
        throw new RetryError(
          `等待重试时被取消：${errorMessage(sleepError)}`,
          attempt,
          error,
          delays,
          'aborted',
        );
      }
    }
  }

  throw new RetryError(
    `已重试 ${Math.max(0, maxAttempts - 1)} 次仍失败：${errorMessage(lastError)}`,
    maxAttempts,
    lastError,
    delays,
    'exhausted',
  );
}
