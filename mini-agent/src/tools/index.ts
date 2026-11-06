/**
 * 默认工具集：
 *   calculator / todo / search / read_file / grep / edit_file / write_file / weather / remember
 *
 * 每个工具都是 defineTool 产物，注册一行即可；
 * loop 通过 registry.list() 自动把新工具暴露给模型，无需改动 loop。
 */

import { rememberTool } from '../memory.js';
import { calculatorTool } from './calculator.js';
import { editFileTool } from './edit-file.js';
import { grepTool } from './grep.js';
import { readFileTool } from './read-file.js';
import { ToolRegistry } from './registry.js';
import { searchTool } from './search.js';
import { createTodoTool } from './todo.js';
import { weatherTool } from './weather.js';
import { writeFileTool } from './write-file.js';

export { CalculatorError, calculatorTool, evaluateExpression, formatNumber } from './calculator.js';
export { ToolRegistry } from './registry.js';
export type { RunOptions, Tool, ToolContext } from './registry.js';
export { defineTool, sha256Hex, toolFail, toolOk, withEffect } from './base.js';
export type { MemoryStoreLike } from './base.js';
export { editFileTool } from './edit-file.js';
export { SafePathError, isInside, resolveSafePath, resolveRoot, toPosix } from './fs-path.js';
export { DEFAULT_SKIP_DIRS, globToRegExp, grepFiles, matchGlob } from './grep-core.js';
export type { GrepMatch, GrepOptions, GrepResult } from './grep-core.js';
export { grepTool } from './grep.js';
export { readFileTool } from './read-file.js';
export { searchDocs, searchTool } from './search.js';
export { createTodoTool } from './todo.js';
export type { TodoItem, TodoTool } from './todo.js';
export { WeatherError, createWeatherTool, describeWeatherCode, formatWeatherSummary, weatherTool } from './weather.js';
export type { WeatherToolOptions } from './weather.js';
export { writeFileTool } from './write-file.js';

/** 创建带内置工具的注册表；每次调用都得到独立的 todo 状态 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  // 基础能力
  registry.register(calculatorTool);
  registry.register(createTodoTool().tool);
  registry.register(searchTool);

  // 文件工具（沙箱在 process.cwd()，可用 ToolContext.rootDir 覆盖）
  registry.register(readFileTool);
  registry.register(grepTool);
  registry.register(editFileTool);
  registry.register(writeFileTool);

  // 外部数据与记忆
  registry.register(weatherTool);
  registry.register(rememberTool);

  return registry;
}
