/**
 * 文件工具共用的沙箱路径解析。
 *
 * 一句话功能：把模型给出的路径解析成「一定位于根目录之内」的绝对路径。
 * 参数：input——相对或绝对路径字符串；rootDir——沙箱根目录，默认 process.cwd()。
 * 返回：{ root, absolute, relative }，relative 是相对 root 的 POSIX 风格路径。
 * 失败情况：空路径 / 含 NUL / 用 .. 或绝对路径越出 root / 经符号链接指向 root 之外，
 *          均抛 SafePathError，由调用方折算成 ok=false。
 *
 * 设计要点：
 * - 先做字面归一化再比较，避免 a/b/../../etc 这类绕行；
 * - 再用 realpath 检查「最深已存在祖先」的真实位置，堵住符号链接逃逸；
 * - Windows 反斜杠统一按分隔符处理，比较时忽略大小写。
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

/** 路径越界/非法时抛出；code 便于调用方分类 */
export class SafePathError extends Error {
  readonly code: string;

  constructor(message: string, code = 'PATH_ESCAPE') {
    super(message);
    this.name = 'SafePathError';
    this.code = code;
  }
}

export interface ResolvedPath {
  /** 沙箱根目录的绝对路径 */
  root: string;
  /** 目标绝对路径（可能尚不存在） */
  absolute: string;
  /** 相对 root 的 POSIX 路径，root 本身为 '.' */
  relative: string;
}

/** 统一成 POSIX 分隔符，便于输出与 glob 匹配 */
export function toPosix(input: string): string {
  return input.split(path.sep).join('/').split('\\').join('/');
}

function comparable(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** target 是否等于 root 或位于 root 之内 */
export function isInside(root: string, target: string): boolean {
  const base = comparable(root);
  const candidate = comparable(target);
  if (candidate === base) return true;
  return candidate.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/**
 * 取「最深已存在祖先」的真实路径，再把尚不存在的尾部拼回去。
 * 这样即使目标文件还没创建，也能发现祖先目录是逃逸的符号链接。
 */
function realish(target: string): string {
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** 解析沙箱根目录（绝对路径） */
export function resolveRoot(rootDir?: string): string {
  return path.resolve(rootDir && rootDir.trim() !== '' ? rootDir : process.cwd());
}

/** 解析并校验路径，越界直接抛 SafePathError */
export function resolveSafePath(input: string, rootDir?: string): ResolvedPath {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new SafePathError('path 不能为空', 'PATH_EMPTY');
  }
  if (input.includes('\u0000')) {
    throw new SafePathError('path 含非法字符 NUL', 'PATH_INVALID');
  }

  const root = resolveRoot(rootDir);
  // Windows 分隔符归一化：反斜杠一律当分隔符处理
  const normalized = input.trim().replace(/[\\/]+/g, path.sep);
  const absolute = path.resolve(root, normalized);

  if (!isInside(root, absolute)) {
    throw new SafePathError(
      `路径越出允许的根目录：${input}（根目录：${root}）。只能访问根目录内的文件，禁止使用 .. 跳出。`,
      'PATH_ESCAPE',
    );
  }

  const realRoot = realish(root);
  const realTarget = realish(absolute);
  if (!isInside(realRoot, realTarget)) {
    throw new SafePathError(
      `路径经符号链接指向根目录之外：${input}（真实路径：${realTarget}）`,
      'PATH_SYMLINK_ESCAPE',
    );
  }

  const relative = toPosix(path.relative(root, absolute)) || '.';
  return { root, absolute, relative };
}
