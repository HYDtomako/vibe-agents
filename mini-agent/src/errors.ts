/**
 * 错误分类：把工具失败与模型调用失败归一成四种处理策略。
 *
 * - retryable：网络抖动、超时、上游 5xx、限流，值得退避后重试；
 * - fatal：参数非法、未知工具、路径越界、edit_file 唯一性冲突等确定性失败，重试没有意义；
 * - quota：额度不足 / 计费被拒绝 / 402 / insufficient_quota，必须停止并明确告知用户；
 * - bad_request：请求本身或凭据不合法（400/401/403/404/413/422），不重试。
 *
 * 工具可以通过 ToolResult.retryable 显式声明，显式声明优先于文本推断。
 * 本文件只做「分类」，不做重试与文案；重试见 retry.ts，用户文案见 loop.ts / cli.ts。
 */

import type { ToolResult } from './types.js';

export type ErrorKind = 'retryable' | 'fatal' | 'quota' | 'bad_request';

/** 一次错误分类的结果：kind + 可读原因 + 可选的 HTTP 状态/服务端等待建议 */
export interface ErrorClassification {
  kind: ErrorKind;
  /** 中文分类说明，可直接写进 trace note */
  reason: string;
  /** HTTP 状态码（有的话） */
  status?: number;
  /** 服务端 Retry-After 折算出的毫秒数（有的话） */
  retryAfterMs?: number;
}

/** 分类的中文标签，用于用户可见文案 */
export const ERROR_KIND_LABELS: Record<ErrorKind, string> = {
  retryable: '可重试的临时故障',
  fatal: '确定性失败（不重试）',
  quota: '额度或计费受限',
  bad_request: '请求或凭据不合法（不重试）',
};

/** kind 是否值得重试 */
export function isRetryableKind(kind: ErrorKind): boolean {
  return kind === 'retryable';
}

const QUOTA_PATTERNS: readonly RegExp[] = [
  /insufficient_quota/i,
  /billing_hard_limit_reached/i,
  /exceeded your current quota/i,
  /quota[_\s-]?(?:exceeded|exhausted|limit|reached)/i,
  /\bquota\b/i,
  /额度/,
  /配额/,
  /余额不足/,
  /计费/,
  /\b402\b/,
];

const NETWORK_PATTERNS: readonly RegExp[] = [
  /\betimedout\b/i,
  /\babort(?:ed|error)?\b/i,
  /\beconn(?:reset|refused|aborted|timedout)\b/i,
  /\benotfound\b/i,
  /\beai_again\b/i,
  /\bepipe\b/i,
  /\behostunreach\b/i,
  /\benetunreach\b/i,
  /socket hang up/i,
  /fetch failed/i,
  /network/i,
  /连接失败/,
  /网络/,
  /timeout|timed out|超时/i,
];

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /限流/,
  /频率限制/,
];

const UPSTREAM_5XX_PATTERNS: readonly RegExp[] = [
  /http[^\d]{0,8}5\d{2}\b/i,
  /\b5xx\b/i,
  /status\s*[:=]?\s*5\d{2}\b/i,
  /\b(?:500|502|503|504|505|507|508|509)\b/,
  /bad gateway|service unavailable|gateway timeout|internal server error/i,
];

const TOOL_FATAL_PATTERNS: readonly RegExp[] = [
  /invalid_arguments/i,
  /invalid argument/i,
  /unknown_tool/i,
  /unknown tool/i,
  /\bschema\b/i,
  /参数不是合法\s*json/i,
  /参数必须/,
  /参数非法/,
  /参数错误/,
  /missing required|required\s+(?:parameter|argument|field)/i,
  /path_escape|path_symlink_escape|path_empty|path_invalid/i,
  /路径越出|路径经符号链接|path\s*不能为空/i,
  /text_not_unique|old_text_empty|new_text_invalid|text_not_found/i,
  /唯一匹配/,
  /出现了\s*\d+\s*次/,
  /file_not_found|is_directory/i,
  /文件不存在|是目录|已经存在|已存在/i,
  /city_not_found|city_required|no_fetch/i,
  /uniqueness|不唯一/i,
];

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

function detailOf(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const detail = (error as { detail?: unknown }).detail;
  return typeof detail === 'string' ? detail : '';
}

/** 从错误对象上读取服务端 Retry-After（毫秒），兼容 retryAfterMs / retryAfter(秒) / headers */
export function readRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as {
    retryAfterMs?: unknown;
    retryAfter?: unknown;
    headers?: { get?: (name: string) => string | null };
  };

  if (typeof record.retryAfterMs === 'number' && Number.isFinite(record.retryAfterMs)) {
    return Math.max(0, Math.floor(record.retryAfterMs));
  }
  if (typeof record.retryAfter === 'number' && Number.isFinite(record.retryAfter)) {
    return Math.max(0, Math.floor(record.retryAfter * 1000));
  }
  if (typeof record.headers?.get === 'function') {
    const header = record.headers.get('retry-after');
    if (header !== null && header.trim() !== '') {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) return Math.max(0, Math.floor(seconds * 1000));
      const timestamp = Date.parse(header);
      if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
    }
  }
  return undefined;
}

function matchAny(patterns: readonly RegExp[], text: string): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return undefined;
}

function quotaClassification(
  text: string,
  matched: string,
  status: number | undefined,
): ErrorClassification {
  return {
    kind: 'quota',
    reason: `额度不足或计费被拒绝（${matched}）`,
    ...(status !== undefined ? { status } : {}),
  };
}

/** 按 result.error / result.output 对工具失败分类 */
export function classifyToolError(result: ToolResult): ErrorClassification {
  if (result.ok) {
    return { kind: 'fatal', reason: '工具执行成功，无需错误分类' };
  }

  const text = `${result.error ?? ''} ${result.output ?? ''}`.toLowerCase();

  const quota = matchAny(QUOTA_PATTERNS, text);
  if (quota) return quotaClassification(text, quota, statusOfFromText(text));

  // 401/403 且消息涉及 key/额度时按配额处理（工具层偶尔会把上游鉴权错误原样带出）
  if (/\b(?:401|403)\b/.test(text) && /(?:api[\s_-]?key|密钥|invalid key|key 无效|额度|quota|billing|credit)/i.test(text)) {
    return quotaClassification(text, '401/403 + key/额度', 401);
  }

  // 工具显式声明优先
  if (result.retryable === true) {
    return { kind: 'retryable', reason: '工具标记为可重试的临时失败' };
  }
  if (result.retryable === false) {
    return { kind: 'fatal', reason: '工具标记为确定性失败（不重试）' };
  }

  const fatal = matchAny(TOOL_FATAL_PATTERNS, text);
  if (fatal) return { kind: 'fatal', reason: `确定性失败（${fatal.trim().toUpperCase()}）` };

  const network = matchAny(NETWORK_PATTERNS, text);
  if (network) return { kind: 'retryable', reason: `网络或超时（${network.trim().toUpperCase()}）` };

  const rateLimit = matchAny(RATE_LIMIT_PATTERNS, text);
  if (rateLimit) return { kind: 'retryable', reason: `限流（${rateLimit.trim().toUpperCase()}）` };

  const upstream = matchAny(UPSTREAM_5XX_PATTERNS, text);
  if (upstream) return { kind: 'retryable', reason: `上游 5xx（${upstream.trim().toUpperCase()}）` };

  // 未知的工具错误默认不重试：盲目重试可能放大副作用
  return { kind: 'fatal', reason: '未识别的工具错误，按确定性失败处理' };
}

function statusOfFromText(text: string): number | undefined {
  const direct = /\b(402|401|403)\b/.exec(text);
  if (!direct) return undefined;
  const parsed = Number(direct[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 按 ModelError.status / 错误文本对模型调用失败分类 */
export function classifyModelError(error: unknown): ErrorClassification {
  const status = statusOf(error);
  const message = safeMessage(error);
  const text = `${message} ${detailOf(error)}`.toLowerCase();

  const quota = matchAny(QUOTA_PATTERNS, text);
  if (quota || status === 402) {
    return quotaClassification(text, quota ?? 'HTTP 402', status ?? 402);
  }

  const retryAfterMs = readRetryAfterMs(error);

  if (status !== undefined && status > 0) {
    if (status === 429) {
      return {
        kind: 'retryable',
        reason: '模型服务限流（HTTP 429）',
        status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    }
    if (status === 408) {
      return { kind: 'retryable', reason: '模型服务请求超时（HTTP 408）', status };
    }
    if (status >= 500 && status <= 599) {
      return { kind: 'retryable', reason: `模型服务上游错误（HTTP ${status}）`, status };
    }
    return {
      kind: 'bad_request',
      reason: `模型请求或凭据不合法（HTTP ${status}）`,
      status,
    };
  }

  const network = matchAny(NETWORK_PATTERNS, text);
  if (network) return { kind: 'retryable', reason: `网络或超时（${network.trim().toUpperCase()}）` };

  const rateLimit = matchAny(RATE_LIMIT_PATTERNS, text);
  if (rateLimit) return { kind: 'retryable', reason: `模型服务限流（${rateLimit.trim().toUpperCase()}）` };

  const upstream = matchAny(UPSTREAM_5XX_PATTERNS, text);
  if (upstream) return { kind: 'retryable', reason: `上游 5xx（${upstream.trim().toUpperCase()}）` };

  return { kind: 'bad_request', reason: '未识别的模型调用错误（按不重试处理）' };
}

/**
 * loop 内部用：把「工具返回 ok=false」包装成可抛出对象，交给 withRetry 统一退避。
 * 不对外暴露给工具作者——工具仍然只返回 ToolResult。
 */
export class ToolExecutionError extends Error {
  readonly result: ToolResult;
  readonly classification: ErrorClassification;

  constructor(result: ToolResult, classification: ErrorClassification) {
    super(result.output || classification.reason);
    this.name = 'ToolExecutionError';
    this.result = result;
    this.classification = classification;
  }
}
