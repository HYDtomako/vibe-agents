/**
 * 工具注册与执行。
 *
 * 约定：
 * - register(tool)：注册一个 defineTool 产物，内部用 Map<name, Tool>；
 * - list()：只导出 { name, description, parameters }，可直接塞进模型请求；
 * - run(name, argsJson)：解析参数并执行，任何异常（未知工具、非法 JSON、run 抛错）
 *   都被捕获并转换成 { ok: false, output }，绝不向外抛，保证 agent loop 不崩。
 */

import { fsWriteEvent } from '../trace.js';
import type { TraceEventDraft } from '../trace.js';
import type { ToolResult, ToolSpec } from '../types.js';
import { defineTool } from './base.js';
import type { Tool, ToolContext } from './base.js';

export type { Tool, ToolContext } from './base.js';

/**
 * run() 的可选上下文：除 toolName 外与 ToolContext 一致。
 * traceEvent 只给 registry 内部用，不会出现在工具的 ctx 里。
 */
export type RunOptions = Omit<ToolContext, 'toolName'> & {
  /** 工具产生文件副作用时，registry 统一转成事件交给它（seq/ts/turn 由 loop 补齐） */
  traceEvent?: (event: TraceEventDraft) => void;
};

/** 把任意返回值转成可读文本 */
function toOutput(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/** 把 run() 的返回值归一化成 ToolResult；容错处理不规范实现 */
function normalize(raw: unknown): Omit<ToolResult, 'durationMs'> {
  if (raw && typeof raw === 'object' && typeof (raw as { ok?: unknown }).ok === 'boolean') {
    const value = raw as ToolResult;
    const result: Omit<ToolResult, 'durationMs'> = {
      ok: value.ok,
      output: typeof value.output === 'string' ? value.output : toOutput(value.output),
      ...(value.error !== undefined ? { error: value.error } : {}),
      ...(value.data !== undefined ? { data: value.data } : {}),
      ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {}),
      ...(value.effect !== undefined ? { effect: value.effect } : {}),
    };
    return result;
  }
  return { ok: true, output: toOutput(raw) };
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /** 注册工具；声明非法、todo 缺失或重名时抛错（注册属于开发期错误，应当尽早暴露） */
  register(tool: Tool): this {
    const validated = defineTool(tool);
    if (this.tools.has(validated.name)) {
      throw new Error(`工具 ${validated.name} 已注册，不能重复注册`);
    }
    this.tools.set(validated.name, validated);
    return this;
  }

  /** 导出给模型的 tools 数组；返回副本，避免外部改动注册表 */
  list(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: { ...tool.parameters },
    }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  get size(): number {
    return this.tools.size;
  }

  /**
   * 执行工具。任何失败都折算成 ToolResult（ok=false），不抛异常。
   * argsJson 为空字符串时按空对象处理（部分模型会给出空参数）。
   */
  async run(name: string, argsJson: string, options: RunOptions = {}): Promise<ToolResult> {
    const startedAt = Date.now();
    const finish = (result: Omit<ToolResult, 'durationMs'>): ToolResult => ({
      ...result,
      durationMs: Date.now() - startedAt,
    });

    const tool = this.tools.get(name);
    if (!tool) {
      const available = [...this.tools.keys()].join(', ') || '（无）';
      return finish({
        ok: false,
        output: `未知工具：${name}。可用工具：${available}`,
        error: 'UNKNOWN_TOOL',
        retryable: false,
      });
    }

    let args: Record<string, unknown>;
    const raw = (argsJson ?? '').trim();
    if (raw === '') {
      args = {};
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        return finish({
          ok: false,
          output: `工具 ${name} 的参数不是合法 JSON：${errorMessage(error)}。原始参数：${raw.slice(0, 200)}`,
          error: 'INVALID_ARGUMENTS_JSON',
          retryable: false,
        });
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return finish({
          ok: false,
          output: `工具 ${name} 的参数必须是 JSON 对象，实际收到：${raw.slice(0, 200)}`,
          error: 'INVALID_ARGUMENTS_TYPE',
          retryable: false,
        });
      }
      args = parsed as Record<string, unknown>;
    }

    const { traceEvent, ...toolOptions } = options;
    const context: ToolContext = { toolName: name, ...toolOptions };
    try {
      const result = finish(normalize(await tool.run(args, context)));
      // 文件副作用统一在这里转成 trace 事件：工具自己不知道 trace 的存在
      if (result.effect) traceEvent?.(fsWriteEvent(result.effect));
      return result;
    } catch (error) {
      return finish({
        ok: false,
        output: `工具 ${name} 执行失败：${errorMessage(error)}`,
        error: errorMessage(error),
      });
    }
  }
}
