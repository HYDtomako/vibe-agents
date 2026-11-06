/**
 * grep 的文件遍历 + 逐行匹配内核。
 *
 * 一句话功能：在目录树里递归扫描文本文件，逐行匹配 pattern，返回结构化命中。
 * 参数：见 GrepOptions（root/path/glob/ignoreCase/regex/maxResults/skipDirs）。
 * 返回：GrepResult，含命中列表、命中总数、命中文件数、扫描文件数与截断标记。
 * 失败情况：root 或 path 越界抛错；单个文件读失败/是二进制/过大直接跳过，不影响整体。
 *
 * 抽成独立模块是为了让 grep 工具和记忆层（memory.ts）共用同一套遍历与匹配逻辑，
 * 避免同一段逻辑抄两份。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { isInside, toPosix } from './fs-path.js';

/** 默认跳过的目录：依赖、版本库、构建产物、覆盖率报告 */
export const DEFAULT_SKIP_DIRS = ['node_modules', '.git', 'dist', 'coverage'];

/** 单文件大小上限，超过直接跳过（避免把构建产物读进内存） */
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
/** 单行输出长度上限 */
const MAX_LINE_CHARS = 300;

export interface GrepOptions {
  /** 匹配模式：regex=false 时按字面量，regex=true 时按正则 */
  pattern: string;
  /** 搜索根目录（绝对路径） */
  root: string;
  /** 相对 root 的子路径；缺省搜索整个 root */
  path?: string;
  /** 文件名过滤，支持 * ? 与 {a,b}，例如 "*.ts"；带斜杠的 glob 匹配相对路径 */
  glob?: string;
  ignoreCase?: boolean;
  regex?: boolean;
  /** 命中条数上限，默认 200 */
  maxResults?: number;
  /** 额外跳过的目录名，默认 node_modules / .git / dist / coverage */
  skipDirs?: string[];
  /** 单文件大小上限，默认 1MB */
  maxFileBytes?: number;
}

export interface GrepMatch {
  /** 绝对路径 */
  file: string;
  /** 相对 root 的 POSIX 路径 */
  relativePath: string;
  /** 1 起始行号 */
  line: number;
  /** 行内容（已去掉尾部空白，过长截断） */
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  totalMatches: number;
  filesWithMatches: number;
  filesScanned: number;
  truncated: boolean;
  searchRoot: string;
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function globBodyToSource(glob: string): string {
  let source = '';
  let index = 0;
  while (index < glob.length) {
    const char = glob[index]!;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        source += '.*';
        index += 2;
        if (glob[index] === '/') index += 1;
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    if (char === '{') {
      const end = glob.indexOf('}', index);
      if (end === -1) {
        source += '\\{';
        index += 1;
        continue;
      }
      const parts = glob.slice(index + 1, end).split(',');
      source += `(?:${parts.map((part) => globBodyToSource(part)).join('|')})`;
      index = end + 1;
      continue;
    }
    source += escapeRegExpChar(char);
    index += 1;
  }
  return source;
}

/** 把 glob 编译成正则（内部使用，也导出给测试） */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globBodyToSource(glob)}$`);
}

/** 没有 `/` 的 glob 只匹配文件名，带 `/` 的匹配相对路径 */
export function matchGlob(relativePath: string, glob: string, regExp: RegExp): boolean {
  if (!glob.includes('/')) {
    const base = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    return regExp.test(base);
  }
  return regExp.test(relativePath);
}

function buildLineMatcher(pattern: string, regex: boolean, ignoreCase: boolean): (line: string) => boolean {
  if (regex) {
    const regExp = new RegExp(pattern, ignoreCase ? 'i' : '');
    return (line) => regExp.test(line);
  }
  if (ignoreCase) {
    const needle = pattern.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
  return (line) => line.includes(pattern);
}

function clipLine(line: string): string {
  const trimmed = line.replace(/\s+$/, '');
  return trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed;
}

/** 简易二进制判定：出现 NUL 字节即视为二进制 */
function looksBinary(text: string): boolean {
  return text.includes('\u0000');
}

/**
 * 递归扫描并逐行匹配。
 * 结果按「目录名/文件名升序」的深度优先顺序返回，保证可复现。
 */
export async function grepFiles(options: GrepOptions): Promise<GrepResult> {
  const root = path.resolve(options.root);
  const searchRoot = options.path ? path.resolve(root, options.path) : root;
  if (!isInside(root, searchRoot)) {
    throw new Error(`搜索路径越出根目录：${searchRoot}`);
  }

  const skipDirs = new Set(options.skipDirs ?? DEFAULT_SKIP_DIRS);
  const maxResults = Math.max(1, Math.floor(options.maxResults ?? 200));
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const globRegExp = options.glob ? globToRegExp(options.glob) : undefined;
  const matchesLine = buildLineMatcher(
    options.pattern,
    options.regex === true,
    options.ignoreCase === true,
  );

  const matches: GrepMatch[] = [];
  const filesWithMatches = new Set<string>();
  let filesScanned = 0;
  let truncated = false;

  const stack: string[] = [searchRoot];
  while (stack.length > 0 && !truncated) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const subdirs: string[] = [];
    for (const entry of entries) {
      if (truncated) break;
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        subdirs.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = toPosix(path.relative(root, fullPath));
      if (globRegExp && options.glob && !matchGlob(relativePath, options.glob, globRegExp)) continue;

      filesScanned += 1;

      let text: string;
      try {
        const info = await stat(fullPath);
        if (info.size > maxFileBytes) continue;
        text = await readFile(fullPath, 'utf8');
      } catch {
        continue;
      }
      if (looksBinary(text)) continue;

      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!matchesLine(line)) continue;
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
        matches.push({
          file: fullPath,
          relativePath,
          line: index + 1,
          text: clipLine(line),
        });
        filesWithMatches.add(relativePath);
      }
    }

    for (let index = subdirs.length - 1; index >= 0; index -= 1) {
      stack.push(subdirs[index]!);
    }
  }

  return {
    matches,
    totalMatches: matches.length,
    filesWithMatches: filesWithMatches.size,
    filesScanned,
    truncated,
    searchRoot,
  };
}
