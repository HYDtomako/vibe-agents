/**
 * grep 工具：在沙箱内递归搜索文本内容。
 *
 * 一句话功能：递归遍历目录（默认跳过 node_modules/.git/dist/coverage），逐行搜索并返回命中的文件/行号/内容。
 * 参数：pattern（必填）；path（搜索起点，默认沙箱根目录）；glob（文件名过滤，如 "*.ts"）；
 *       ignoreCase（忽略大小写）；regex（按正则解释 pattern）；maxResults（命中上限，默认 200）。
 * 返回：每行 `相对路径:行号: 行内容`，末尾给出「匹配总数 / 匹配文件数 / 扫描文件数」，被截断时明确说明。
 * 失败情况：path 越界、pattern 为空、regex 非法，均返回 ok=false；单个文件读失败会被跳过，不影响整体。
 */

import { defineTool, toolFail, toolOk } from './base.js';
import { SafePathError, resolveSafePath } from './fs-path.js';
import { grepFiles } from './grep-core.js';

/** 默认命中上限 */
const DEFAULT_MAX_RESULTS = 200;

function readInt(value: unknown, fallback: number, min: number, max: number): number {
  let parsed = fallback;
  if (typeof value === 'number' && Number.isFinite(value)) parsed = Math.floor(value);
  else if (typeof value === 'string' && value.trim() !== '') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) parsed = Math.floor(asNumber);
  }
  return Math.min(max, Math.max(min, parsed));
}

function readBool(value: unknown): boolean {
  return value === true || value === 'true';
}

export const grepTool = defineTool({
  name: 'grep',
  description:
    '递归搜索沙箱内文件的文本内容，默认跳过 node_modules/.git/dist/coverage；返回「相对路径:行号: 行内容」并汇总命中统计。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '要搜索的文本；regex=true 时按正则解释' },
      path: { type: 'string', description: '搜索起点，相对沙箱根目录，默认根目录' },
      glob: { type: 'string', description: '文件名过滤，例如 "*.ts" 或 "src/**/*.md"' },
      ignoreCase: { type: 'boolean', description: '是否忽略大小写，默认 false' },
      regex: { type: 'boolean', description: '是否把 pattern 当正则，默认 false（按字面量）' },
      maxResults: { type: 'integer', description: '命中条数上限，默认 200' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  todo: [
    '按内容搜索文件，用于在不确定具体文件时定位代码位置。',
    '第一步：解析 path（默认沙箱根目录），越界直接失败。',
    '第二步：按 glob 过滤文件名，递归遍历并跳过 node_modules / .git / dist / coverage。',
    '第三步：逐行匹配（可选忽略大小写或正则），累积命中直到 maxResults。',
    '第四步：输出 `相对路径:行号: 行内容`，末尾汇总匹配总数/匹配文件数/扫描文件数。',
    '边界：只搜文本文件（含 NUL 字节或超过 1MB 的文件跳过），不搜二进制、不跨沙箱。',
    '失败情况：path 越界、pattern 为空、正则有语法错误时返回 ok=false；无命中返回 ok=true 与「没有找到」。',
  ],
  async run(args, ctx) {
    try {
      const patternRaw = args['pattern'];
      if (typeof patternRaw !== 'string' || patternRaw === '') {
        return toolFail('pattern 不能为空字符串', 'PATTERN_EMPTY');
      }

      const rawPath = args['path'];
      let searchPath: string | undefined;
      let shownPath = '.';
      if (typeof rawPath === 'string' && rawPath.trim() !== '') {
        const resolved = resolveSafePath(rawPath, ctx.rootDir);
        shownPath = resolved.relative;
        searchPath = resolved.relative === '.' ? undefined : resolved.relative;
      }

      const root = resolveSafePath('.', ctx.rootDir).root;
      const maxResults = readInt(args['maxResults'], DEFAULT_MAX_RESULTS, 1, 5000);
      const glob = typeof args['glob'] === 'string' && args['glob'].trim() !== '' ? args['glob'].trim() : undefined;

      const result = await grepFiles({
        root,
        pattern: patternRaw,
        ...(searchPath ? { path: searchPath } : {}),
        ...(glob ? { glob } : {}),
        ignoreCase: readBool(args['ignoreCase']),
        regex: readBool(args['regex']),
        maxResults,
      });

      if (result.totalMatches === 0) {
        return toolOk(
          `没有找到匹配「${patternRaw}」的内容（搜索范围：${shownPath}，扫描 ${result.filesScanned} 个文件）`,
          result,
        );
      }

      const lines = result.matches.map((match) => `${match.relativePath}:${match.line}: ${match.text}`);
      lines.push(
        `—— 匹配 ${result.totalMatches} 处，涉及 ${result.filesWithMatches} 个文件（扫描 ${result.filesScanned} 个文件）`,
      );
      if (result.truncated) {
        lines.push(`（已截断：只显示前 ${maxResults} 条命中，可缩小 path/glob 范围或调高 maxResults）`);
      }
      return toolOk(lines.join('\n'), result);
    } catch (error) {
      if (error instanceof SafePathError) return toolFail(error.message, error.code);
      const reason = error instanceof Error ? error.message : String(error);
      if (/Invalid regular expression/i.test(reason)) {
        return toolFail(`正则表达式非法：${reason}`, 'INVALID_REGEX');
      }
      return toolFail(`搜索失败：${reason}`, 'GREP_FAILED');
    }
  },
});
