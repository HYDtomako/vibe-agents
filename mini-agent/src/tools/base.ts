/**
 * 工具统一写法：defineTool + Tool 接口。
 *
 * 约定：
 * - 每个工具声明 name / description / parameters(JSON Schema) / todo / run；
 * - todo 是给 agent 做规划用的自然语言说明（做什么、分几步、边界与失败情况），
 *   不允许出现 TODO / TBD 之类的占位符；
 * - run 返回 ToolResult；是否抛异常由工具自己决定，registry 会兜底成 ok=false；
 * - 会改文件的工具在覆盖前调 ctx.snapshot(path) 留原文件快照，并用 withEffect 声明副作用，
 *   registry 统一把 effect 转成 fs.write trace 事件（工具本身不 import trace）。
 */

import { createHash } from 'node:crypto';

import type { JsonSchema, ToolEffect, ToolResult, ToolSnapshot } from '../types.js';

/** 工具执行上下文；由 registry 组装，随每次调用传入 */
export interface ToolContext {
  /** 工具名 */
  toolName: string;
  /** 预留：当前会话 id */
  sessionId?: string;
  /** 文件工具与记忆工具的沙箱根目录，默认 process.cwd() */
  rootDir?: string;
  /** 可注入的 fetch 实现（weather 用），默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** 记忆存储（remember 工具用）；未配置时 remember 返回 ok=false */
  memory?: MemoryStoreLike;
  /**
   * 覆盖前抓原文件快照（只对要写的文件抓）。
   * 传入沙箱内相对路径；文件不存在或未配置 trace 落盘时返回 undefined。
   */
  snapshot?: (path: string) => Promise<ToolSnapshot | undefined>;
}

/**
 * memory 模块的最小结构约定。
 * 这里只声明 remember 工具真正用到的方法，避免 base.ts 反向依赖具体实现。
 */
export interface MemoryStoreLike {
  append(input: { text: string; tag?: string; kind?: string }): Promise<{ path: string; count: number; added: boolean }>;
}

/** 一个工具：声明 + 实现 */
export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** 规划说明：这个工具做什么、分几步、边界与失败情况 */
  todo: string[];
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** 占位符检测：大写 TODO / TBD 出现在 todo 里说明作者没写清楚（小写 todo 是合法词，不拦） */
const PLACEHOLDER = /\b(?:TODO|TBD)\b/;

/** 构造成功结果 */
export function toolOk(output: string, data?: unknown): ToolResult {
  return data === undefined ? { ok: true, output } : { ok: true, output, data };
}

/** 构造失败结果（失败也是正常返回值，不抛异常）；retryable 可显式声明是否值得重试 */
export function toolFail(output: string, error?: string, retryable?: boolean): ToolResult {
  const result: ToolResult = { ok: false, output };
  if (error !== undefined) result.error = error;
  if (retryable !== undefined) result.retryable = retryable;
  return result;
}

/**
 * 给结果挂上文件副作用描述。
 * 工具只声明「写了什么」，registry 负责把它转成 fs.write trace 事件——
 * 工具本身不 import trace，保持「工具只产 ToolResult」的约定。
 */
export function withEffect(result: ToolResult, effect: ToolEffect): ToolResult {
  return { ...result, effect };
}

/** sha256（十六进制）：工具算写入后的内容指纹，trace 算原文件快照指纹 */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 校验并返回工具定义。
 * 校验发生在注册期，属于开发期错误，因此直接抛错尽快暴露。
 */
export function defineTool(tool: Tool): Tool {
  if (!tool || typeof tool !== 'object') {
    throw new Error('defineTool 需要一个工具对象');
  }
  if (typeof tool.name !== 'string' || tool.name.trim() === '') {
    throw new Error('工具 name 不能为空');
  }
  if (typeof tool.description !== 'string' || tool.description.trim() === '') {
    throw new Error(`工具 ${tool.name} 缺少 description`);
  }
  const parameters = tool.parameters;
  if (!parameters || typeof parameters !== 'object' || parameters.type !== 'object') {
    throw new Error(`工具 ${tool.name} 的 parameters 必须是 type:'object' 的 JSON Schema`);
  }
  if (!Array.isArray(tool.todo) || tool.todo.length === 0) {
    throw new Error(
      `工具 ${tool.name} 的 todo 必须是非空数组：写清这个工具做什么、分几步、边界与失败情况，供 agent 规划`,
    );
  }
  for (const item of tool.todo) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`工具 ${tool.name} 的 todo 每项都必须是非空字符串`);
    }
    if (PLACEHOLDER.test(item)) {
      throw new Error(`工具 ${tool.name} 的 todo 含占位符 TODO/TBD：${item}`);
    }
  }
  if (typeof tool.run !== 'function') {
    throw new Error(`工具 ${tool.name} 缺少 run 实现`);
  }
  return tool;
}
