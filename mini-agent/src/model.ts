/**
 * 模型适配层。
 *
 * 只用 Node 内置 fetch 直接请求 OpenAI-compatible 的 /chat/completions，
 * 不依赖任何官方 SDK 或 agent 框架。
 *
 * 关键点：
 * - 超时：AbortController + 定时器，超时抛 ModelError（status=0）；
 * - 错误：非 2xx 抛带 HTTP 状态码的 ModelError，响应体摘要放进 detail；
 * - 解析：tool_calls 原样保留 arguments 字符串，非法 JSON 交给工具层兜底；
 * - usage：透传 prompt/completion/total tokens；
 * - 可注入：fetchImpl 与整个 ModelClient 接口都可替换，测试不碰网络。
 */

import { parseRetryAfterMs } from './retry.js';
import type { JsonSchema, Message, ModelClient, ModelResponse, ToolCall, ToolSpec, Usage } from './types.js';

/** 模型调用相关错误，带 HTTP 状态码（网络/超时/解析错误用 0） */
export class ModelError extends Error {
  readonly status: number;
  readonly detail?: string;
  /** 服务端 Retry-After 折算的毫秒数（有的话） */
  readonly retryAfterMs?: number;

  constructor(message: string, status = 0, detail?: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.detail = detail;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export interface OpenAICompatibleClientOptions {
  /** 服务根地址，例如 https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单次调用超时，默认 60000ms */
  timeoutMs?: number;
  /** 可注入的 fetch 实现，默认使用全局 fetch */
  fetchImpl?: typeof fetch;
  /** 透传给请求体的额外参数，例如 { temperature: 0 } */
  requestOptions?: Record<string, unknown>;
}

/** wire format：仅在本文件内部使用 */
interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface WireResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: WireToolCall[] };
    finish_reason?: string;
  }>;
  usage?: WireUsage;
  error?: { message?: string; type?: string };
}

/** OpenAI tools 的 function 包装形态 */
interface WireTool {
  type: 'function';
  function: { name: string; description: string; parameters: JsonSchema };
}

/** 内部 ToolSpec -> OpenAI tools 数组 */
function toWireTools(tools: ToolSpec[]): WireTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** 内部 Message -> OpenAI wire format */
function toWireMessage(message: Message): WireMessage {
  const wire: WireMessage = {
    role: message.role,
    content: message.content ?? '',
  };
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    wire.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (message.role === 'tool') {
    wire.tool_call_id = message.toolCallId ?? '';
    if (message.name) wire.name = message.name;
  }
  return wire;
}

/** 拼接 chat/completions 地址；允许 baseUrl 直接写成完整 endpoint */
function resolveEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

function mapUsage(usage?: WireUsage): Usage | undefined {
  if (!usage) return undefined;
  const mapped: Usage = {};
  if (typeof usage.prompt_tokens === 'number') mapped.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') mapped.completionTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === 'number') mapped.totalTokens = usage.total_tokens;
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

export class OpenAICompatibleClient implements ModelClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly requestOptions: Record<string, unknown>;

  constructor(options: OpenAICompatibleClientOptions) {
    if (!options.baseUrl) throw new ModelError('缺少 baseUrl，无法创建模型客户端');
    if (!options.apiKey) throw new ModelError('缺少 apiKey，模型凭据只能来自环境变量');
    if (!options.model) throw new ModelError('缺少 model 名称');

    this.endpoint = resolveEndpoint(options.baseUrl);
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.requestOptions = options.requestOptions ?? {};
    if (typeof this.fetchImpl !== 'function') {
      throw new ModelError('当前 Node 运行时没有全局 fetch，请升级到 Node 18+');
    }
  }

  async chat(messages: Message[], tools?: ToolSpec[]): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      ...this.requestOptions,
      model: this.model,
      messages: messages.map(toWireMessage),
    };
    // 没有工具时不发 tools 字段，避免部分服务端报错；有工具时包装成 OpenAI 的 function 形态
    if (tools && tools.length > 0) body.tools = toWireTools(tools);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        throw new ModelError(`模型调用超时（${this.timeoutMs}ms）`, 0, reason);
      }
      throw new ModelError(`模型调用网络错误：${reason}`, 0);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => '');

    if (!response.ok) {
      let detail = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as WireResponse;
        if (parsed.error?.message) detail = parsed.error.message;
      } catch {
        // 响应体不是 JSON，保留原文摘要
      }
      // 429/503 常带 Retry-After，交给 loop 的重试层按服务端建议等待（封顶）
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      throw new ModelError(
        `模型调用失败：HTTP ${response.status}`,
        response.status,
        detail,
        retryAfterMs,
      );
    }

    let payload: WireResponse;
    try {
      payload = JSON.parse(text) as WireResponse;
    } catch {
      throw new ModelError('模型返回不是合法 JSON', response.status, text.slice(0, 500));
    }

    const choice = payload.choices?.[0];
    if (!choice || !choice.message) {
      throw new ModelError('模型返回缺少 choices[0].message', response.status, text.slice(0, 500));
    }

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((call, index) => ({
      // 少数服务端不返回 id，这里补一个稳定占位，保证 tool 消息能回填
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '{}',
    }));

    return {
      content: choice.message.content ?? '',
      toolCalls,
      usage: mapUsage(payload.usage),
      raw: payload,
    };
  }
}

/** 环境变量名集中在此，避免散落各处 */
export const ENV_KEYS = {
  baseUrl: 'LLM_BASE_URL',
  apiKey: 'LLM_API_KEY',
  model: 'LLM_MODEL',
  timeoutMs: 'LLM_TIMEOUT_MS',
} as const;

export interface EnvConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/** 从环境变量读取配置；缺 key 时返回 null，由调用方决定如何提示 */
export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig | null {
  const apiKey = env[ENV_KEYS.apiKey]?.trim();
  if (!apiKey) return null;

  const timeoutRaw = Number(env[ENV_KEYS.timeoutMs]);
  return {
    baseUrl: env[ENV_KEYS.baseUrl]?.trim() || 'https://api.openai.com/v1',
    apiKey,
    model: env[ENV_KEYS.model]?.trim() || 'gpt-4o-mini',
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 60_000,
  };
}

/** 从环境变量创建真实客户端（CLI 用）；配置不完整时抛 ModelError */
export function createClientFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAICompatibleClient {
  const config = readEnvConfig(env);
  if (!config) {
    throw new ModelError(`缺少环境变量 ${ENV_KEYS.apiKey}，无法创建模型客户端`);
  }
  return new OpenAICompatibleClient(config);
}
