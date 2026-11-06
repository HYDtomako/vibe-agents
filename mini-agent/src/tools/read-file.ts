/**
 * read_file 工具：按行读取沙箱内文本文件。
 *
 * 一句话功能：读取文件的一段行范围，输出带行号的内容，便于模型定位代码。
 * 参数：path（必填，沙箱内相对路径）；offset（起始行，1 起始，默认 1）；
 *       limit（最多读取行数，默认 200，上限 2000）。
 * 返回：`<相对路径>（共 N 行）` 头部 + `  12| 内容` 形式的行；被截断时明确写出「已截断，共 N 行」。
 * 失败情况：路径越界、文件不存在、目标是目录、疑似二进制、offset 超出总行数，均返回 ok=false。
 *
 * 只降载不丢行：截断时提示用 offset/limit 继续读取，避免模型一次拉爆上下文。
 */

import { readFile, stat } from 'node:fs/promises';

import { defineTool, toolFail, toolOk } from './base.js';
import { SafePathError, resolveSafePath } from './fs-path.js';

/** 默认读取行数 */
const DEFAULT_LIMIT = 200;
/** 单次最多读取行数 */
const MAX_LIMIT = 2000;
/** 行号列宽下限，保证 `  12| ` 这样的对齐 */
const MIN_LINE_NUMBER_WIDTH = 4;

function readInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return fallback;
}

/** 简易二进制判定：NUL 字节或可打印字符比例过低 */
function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  if (sample.includes(0)) return true;
  if (sample.length === 0) return false;
  let nonPrintable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32 || byte === 127) nonPrintable += 1;
  }
  return nonPrintable / sample.length > 0.3;
}

/** 把行范围渲染成 `  12| 内容` */
export function formatNumberedLines(lines: string[], startLine: number, totalLines: number): string {
  const width = Math.max(MIN_LINE_NUMBER_WIDTH, String(totalLines).length);
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width)}| ${line}`)
    .join('\n');
}

export const readFileTool = defineTool({
  name: 'read_file',
  description: '读取沙箱内文本文件的一段行范围，输出带行号的内容；默认 200 行、最多 2000 行。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，相对当前工作目录（沙箱根目录）' },
      offset: { type: 'integer', description: '起始行号，1 起始，默认 1' },
      limit: { type: 'integer', description: '最多读取行数，默认 200，上限 2000' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  todo: [
    '按行读取沙箱内一个文本文件，给模型提供带行号的原文，用于定位与引用代码。',
    '第一步：解析 path 到沙箱内绝对路径，越界直接失败（含 .. 与符号链接逃逸）。',
    '第二步：stat 检查存在且是普通文件，读取后用 NUL 字节与不可打印字符比例判定是否二进制。',
    '第三步：按 offset/limit 切片（默认第 1 行起、200 行，上限 2000 行），补行号列渲染。',
    '边界：只读文本文件，不跟随目录；单次不返回超过 2000 行，超出部分要求用 offset 续读。',
    '失败情况：路径越界、文件不存在、目标是目录、疑似二进制、offset 超过总行数，均返回 ok=false。',
  ],
  async run(args, ctx) {
    try {
      const target = resolveSafePath(String(args['path'] ?? ''), ctx.rootDir);

      let info;
      try {
        info = await stat(target.absolute);
      } catch {
        return toolFail(`文件不存在：${target.relative}（沙箱根目录：${target.root}）`, 'FILE_NOT_FOUND');
      }
      if (info.isDirectory()) {
        return toolFail(
          `${target.relative} 是一个目录，read_file 只能读文件；想搜目录内容请用 grep。`,
          'IS_DIRECTORY',
        );
      }

      const buffer = await readFile(target.absolute);
      if (looksBinary(buffer)) {
        return toolFail(`${target.relative} 疑似二进制文件（含不可打印字节），read_file 只读取文本。`, 'BINARY_FILE');
      }

      const lines = buffer.toString('utf8').split(/\r?\n/);
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      const totalLines = lines.length;
      if (totalLines === 0) {
        return toolOk(`${target.relative}：文件为空（0 行）`);
      }

      const offset = Math.max(1, readInt(args['offset'], 1));
      const limit = Math.min(MAX_LIMIT, Math.max(1, readInt(args['limit'], DEFAULT_LIMIT)));

      if (offset > totalLines) {
        return toolFail(
          `offset=${offset} 超出文件总行数 ${totalLines}（${target.relative}）`,
          'OFFSET_OUT_OF_RANGE',
        );
      }

      const startLine = offset;
      const endLine = Math.min(totalLines, offset + limit - 1);
      const body = formatNumberedLines(lines.slice(startLine - 1, endLine), startLine, totalLines);

      const parts = [`# ${target.relative}（共 ${totalLines} 行）`, body];
      if (endLine < totalLines) {
        parts.push(
          `（已截断，共 ${totalLines} 行；本次显示第 ${startLine}-${endLine} 行，可用 offset=${endLine + 1} 继续读取）`,
        );
      }
      return toolOk(parts.join('\n'), { totalLines, startLine, endLine, truncated: endLine < totalLines });
    } catch (error) {
      if (error instanceof SafePathError) return toolFail(error.message, error.code);
      const reason = error instanceof Error ? error.message : String(error);
      return toolFail(`读取失败：${reason}`, 'READ_FAILED');
    }
  },
});
