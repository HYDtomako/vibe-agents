/**
 * 库入口：对外暴露稳定 API，方便被其他程序嵌入（CLI 只是其中一个消费者）。
 */

export * from './types.js';
export {
  AgentLoop,
  DEFAULT_MAX_TURNS,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TOOL_FAILURE_THRESHOLD,
  QUOTA_ANSWER,
  buildToolFailureReceipt,
  createAgentLoop,
  summarize,
} from './loop.js';
export type { AgentLoopOptions, LoopRetryOptions, RunOptions, TraceEmit, TraceLogger } from './loop.js';
export {
  DEFAULT_TRACE_DIR,
  MarkdownSink,
  SNAPSHOT_DIR,
  TRACE_FILE_NAME,
  createRunId,
  fsWriteEvent,
  stampEvent,
} from './trace.js';
export type {
  ContextCompactEvent,
  ErrorEvent,
  FsWriteEvent,
  MarkdownSinkOptions,
  MemoryInjectEvent,
  ModelReplyEvent,
  ModelRetryEvent,
  RunEndEvent,
  RunStartEvent,
  ToolCallEvent,
  ToolResultEvent,
  TraceEvent,
  TraceEventBase,
  TraceEventDraft,
  TraceEventType,
  TraceSink,
  TraceToolCall,
} from './trace.js';
export {
  ERROR_KIND_LABELS,
  ToolExecutionError,
  classifyModelError,
  classifyToolError,
  isRetryableKind,
  readRetryAfterMs,
} from './errors.js';
export type { ErrorClassification, ErrorKind } from './errors.js';
export {
  RetryError,
  computeBackoffDelay,
  defaultSleep,
  parseRetryAfterMs,
  withRetry,
} from './retry.js';
export type { RetryOptions, RetryStopReason, SleepFn } from './retry.js';
export {
  BUDGET_ENV_KEY,
  DEFAULT_USAGE_FILE,
  USAGE_ENV_KEY,
  UsageTracker,
  createUsageTracker,
  readBudgetTokens,
  resolveUsageFile,
  usageFilePathFromEnv,
} from './usage.js';
export type { UsageFilePayload, UsageTrackerOptions } from './usage.js';
export {
  ContextEngine,
  MEMORY_MARKER,
  SUMMARY_MARKER,
  countChars,
  countTurns,
  createContextEngine,
  estimateMessagesTokens,
  estimateTokens,
  splitTurns,
} from './context.js';
export type { ContextEngineOptions, ContextStats, FitOptions, FitResult } from './context.js';
export {
  MEMORY_KINDS,
  MemoryError,
  MemoryStore,
  formatMemoryForPrompt,
  parseMemoryLine,
  rememberTool,
  scoreMemoryEntry,
  tokenizeQuery,
} from './memory.js';
export type {
  MemoryAppendInput,
  MemoryAppendResult,
  MemoryEntry,
  MemoryHit,
  MemoryKind,
  MemorySearchOptions,
  MemoryStoreOptions,
} from './memory.js';
export {
  ENV_KEYS,
  ModelError,
  OpenAICompatibleClient,
  createClientFromEnv,
  readEnvConfig,
} from './model.js';
export type { EnvConfig, OpenAICompatibleClientOptions } from './model.js';
export {
  CalculatorError,
  ToolRegistry,
  createDefaultRegistry,
  createTodoTool,
  defineTool,
  evaluateExpression,
  formatNumber,
  sha256Hex,
  toolFail,
  toolOk,
  withEffect,
} from './tools/index.js';
export type {
  MemoryStoreLike,
  RunOptions as ToolRunOptions,
  TodoItem,
  TodoTool,
  Tool,
  ToolContext,
} from './tools/index.js';
