/**
 * 核心类型定义。
 *
 * 设计原则：
 * - 不绑定任何厂商的 wire format，OpenAI-compatible 的转换只发生在 model.ts 内部；
 * - 所有可选能力（多 session、context 压缩、记忆）都通过「可选字段 + 接口」预留扩展点，
 *   本阶段不实现，但后续不需要改已有调用方。
 */

/** 消息角色 */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** 模型发起的一次工具调用；arguments 保留原始 JSON 字符串，便于原样回灌与容错解析 */
export interface ToolCall {
  id: string;
  name: string;
  /** 模型给出的参数，JSON 字符串（可能是非法 JSON，由工具层统一捕获） */
  arguments: string;
}

/** 内部消息结构（与具体模型协议解耦） */
export interface Message {
  role: Role;
  content: string;
  /** role=assistant 时可能带工具调用 */
  toolCalls?: ToolCall[];
  /** role=tool 时，回填对应的 tool_call id */
  toolCallId?: string;
  /** role=tool 时的工具名，便于阅读 trace 与调试 */
  name?: string;
  /** 预留：消息创建时间（毫秒时间戳），后续做 context 压缩时用于裁剪 */
  createdAt?: number;
}

/** 工具声明：直接映射为模型 tools 数组的一项 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema（object 类型） */
  parameters: JsonSchema;
}

/** 一个够用的 JSON Schema 子集，避免引入额外类型依赖 */
export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly (string | number | boolean)[];
  default?: unknown;
  [key: string]: unknown;
}

/**
 * 文件副作用描述：工具只声明「我写了哪个文件、写了多少」，不接触 trace。
 * registry 执行完工具后统一把它转成 fs.write 事件（见 tools/registry.ts）。
 */
export interface ToolEffect {
  type: 'fs.write' | 'edit';
  /** 沙箱内相对路径（POSIX 分隔符） */
  path: string;
  /** 写入的字节数（UTF-8） */
  bytes: number;
  /** 是否覆盖了原有文件 */
  overwritten: boolean;
  /** 覆盖前的原文件 sha256（新建文件没有） */
  beforeSha256?: string;
  /** 写入后文件的 sha256 */
  afterSha256?: string;
  /** 原文件快照在 trace 目录内的相对路径，例如 snapshots/1-notes.txt */
  snapshot?: string;
}

/** 覆盖前抓到的原文件快照；只对被写的文件抓，不做全量备份 */
export interface ToolSnapshot {
  /** 原文件内容的 sha256 */
  sha256: string;
  /** trace 目录内的快照相对路径（写快照失败时缺省） */
  snapshot?: string;
}

/** 工具执行的统一返回；run() 永不向外抛异常 */
export interface ToolResult {
  ok: boolean;
  /** 人类/模型可读的结果文本；失败时为错误说明 */
  output: string;
  /** 失败时的机器可读错误信息 */
  error?: string;
  /** 预留：结构化结果，供 UI 渲染或后续记忆写入 */
  data?: unknown;
  /** 工具自身耗时 */
  durationMs?: number;
  /** 只读：本次执行产生的文件副作用，供 registry 转换成 fs.write trace 事件 */
  readonly effect?: ToolEffect;
  /**
   * 工具自己对失败是否可重试的声明（可选）。
   * true = 网络/上游抖动这类临时失败，允许 loop 重试；
   * false = 参数错误、路径越界、唯一性冲突等确定性失败，不重试；
   * 不填则由 errors.classifyToolError 按 error/output 文本推断。
   */
  retryable?: boolean;
}

/** token 用量（透传模型返回） */
export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** 模型单次响应 */
export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  /** 预留：原始响应，调试/评测用 */
  raw?: unknown;
}

/**
 * 模型客户端接口：唯一与模型打交道的入口。
 * 测试通过注入假实现来脚本化响应，不依赖网络与真实 key。
 */
export interface ModelClient {
  chat(messages: Message[], tools?: ToolSpec[]): Promise<ModelResponse>;
}

/** trace 记录种类 */
export type TraceKind = 'model' | 'tool' | 'final' | 'error';

/** 一条 trace：每轮模型调用、每次工具执行、最终结果各记录一条 */
export interface TraceEntry {
  /** 轮次，从 1 开始 */
  turn: number;
  kind: TraceKind;
  /** 预留：多 session 隔离后用于区分会话 */
  sessionId?: string;
  /** kind=tool 时的工具名 */
  toolName?: string;
  /** kind=tool 时的原始参数 JSON 字符串 */
  args?: string;
  /** 结果摘要（已截断，避免 trace 膨胀） */
  resultSummary?: string;
  ok?: boolean;
  /** 本次操作耗时（毫秒） */
  durationMs: number;
  /** kind=model 时透传模型 usage */
  usage?: Usage;
  /** 补充说明，例如终止原因、错误详情 */
  note?: string;
}

/** agent loop 的终止原因 */
export type StopReason =
  | 'final'
  | 'max_turns'
  | 'model_error'
  /** 同一工具连续失败达到阈值，熔断终止 */
  | 'tool_failure'
  /** 额度 / 预算耗尽（402、insufficient_quota 或本地 budgetTokens 超限） */
  | 'quota_exhausted'
  /** 可重试错误已用尽重试次数 */
  | 'retry_exhausted';

/** token 用量的累计快照（UsageTracker） */
export interface UsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 成功拿到响应的模型调用次数 */
  calls: number;
  /** 模型调用失败次数（含重试中的失败尝试） */
  failures: number;
  /** 重试次数（模型 + 工具） */
  retries: number;
  /** 上游没有返回 usage（或字段缺失）的调用次数；缺失字段按 0 计 */
  missingUsageCalls: number;
  /** 配置的 token 预算上限 */
  budgetTokens?: number;
  /** 累计用量是否已达到/超过预算 */
  overBudget: boolean;
}

/** loop 运行统计（异常、重试、用量），供调用方观测 */
export interface LoopStats {
  /** 成功的模型调用次数 */
  modelCalls: number;
  /** 模型调用重试次数 */
  modelRetries: number;
  /** 模型向工具发起的逻辑调用次数 */
  toolCalls: number;
  /** 重试耗尽或确定性失败的逻辑调用次数 */
  toolFailures: number;
  /** 工具重试次数 */
  toolRetries: number;
  /** 本次运行的用量快照 */
  usage: UsageSnapshot;
}

/** loop 执行结果 */
export interface LoopResult {
  /** 最终回复文本（终止于错误时也给出可读说明） */
  answer: string;
  stopReason: StopReason;
  /** 实际经过的轮次 */
  turns: number;
  trace: TraceEntry[];
  /** 本次运行产生的完整消息序列（含 system/user/assistant/tool） */
  messages: Message[];
  /** 本次运行的异常/重试/用量统计 */
  stats?: LoopStats;
}

/**
 * 一个会话的持久状态；由 session.ts 的 SessionStore 落盘到 <dir>/<id>.json。
 * messages 不含 system 提示（system 每次 run 由 loop 重新拼），只保留可续聊的历史。
 */
export interface SessionState {
  id: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}
