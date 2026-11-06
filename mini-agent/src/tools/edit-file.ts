/**
 * edit_file 工具：按「唯一文本片段」做局部替换。
 *
 * 一句话功能：把文件里唯一出现的 oldText 替换成 newText，用于精确改动已有文件。
 * 参数：path（必填）；oldText（必填，必须在文件中唯一出现）；newText（必填，可为空串表示删除）。
 * 返回：替换的行区间 + 替换后附近几行摘要，便于模型确认改对了位置。
 * 失败情况：路径越界、文件不存在/是目录、oldText 为空、oldText 出现 0 次或多次时返回 ok=false，
 *          多次命中会给出出现次数与每个出现位置的行号，并提示补充更多上下文。
 */

import { readFile, stat, writeFile } from 'node:fs/promises';

import { defineTool, sha256Hex, toolFail, toolOk, withEffect } from './base.js';
import { SafePathError, resolveSafePath } from './fs-path.js';

/** 摘要里前后各带几行 */
const CONTEXT_LINES = 2;

function requireString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

/** 找出所有出现位置（非重叠） */
function findAll(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  let from = 0;
  for (;;) {
    const found = haystack.indexOf(needle, from);
    if (found === -1) return positions;
    positions.push(found);
    from = found + needle.length;
  }
}

/** 字符下标 -> 1 起始行号 */
function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function countNewlines(text: string): number {
  let count = 0;
  for (const char of text) if (char === '\n') count += 1;
  return count;
}

/** 渲染替换后 [start-CONTEXT, end+CONTEXT] 的区域，带行号 */
function renderContext(lines: string[], startLine: number, endLine: number, totalLines: number): string {
  const from = Math.max(1, startLine - CONTEXT_LINES);
  const to = Math.min(totalLines, endLine + CONTEXT_LINES);
  const width = Math.max(4, String(totalLines).length);
  const out: string[] = [];
  for (let line = from; line <= to; line += 1) {
    out.push(`${String(line).padStart(width)}| ${lines[line - 1] ?? ''}`);
  }
  return out.join('\n');
}

export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    '把文件中唯一出现的 oldText 替换为 newText。oldText 必须唯一匹配；0 次或多次都会报错并提示补充上下文。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，相对沙箱根目录' },
      oldText: { type: 'string', description: '要被替换的原文片段，必须在文件中唯一出现' },
      newText: { type: 'string', description: '替换后的内容；空字符串表示删除该片段' },
    },
    required: ['path', 'oldText', 'newText'],
    additionalProperties: false,
  },
  todo: [
    '对已存在的文件做精确局部修改，比整体重写更安全。',
    '第一步：解析 path，越界或不存在直接失败；oldText 不能是空串。',
    '第二步：统计 oldText 在文件中的出现次数。',
    '第三步：必须恰好出现一次；0 次提示原文不匹配，多次则报出出现次数与各次行号，要求补充更多上下文。',
    '第四步：替换并写回文件，返回替换的行区间与替换后附近几行。',
    '边界：不做模糊匹配、不做多文件批量替换；旧文本重复出现时不会猜测要改哪一处。',
    '失败情况：路径越界、文件不存在或为目录、oldText 为空、出现 0 次或多次、写入失败，均返回 ok=false。',
  ],
  async run(args, ctx) {
    try {
      const target = resolveSafePath(String(args['path'] ?? ''), ctx.rootDir);
      const oldText = requireString(args, 'oldText');
      const newText = requireString(args, 'newText');

      if (oldText === null || oldText === '') {
        return toolFail('oldText 必须是非空字符串：请提供要替换的原文片段', 'OLD_TEXT_EMPTY');
      }
      if (newText === null) {
        return toolFail('newText 必须是字符串（删除内容请传空字符串 ""）', 'NEW_TEXT_INVALID');
      }

      let info;
      try {
        info = await stat(target.absolute);
      } catch {
        return toolFail(`文件不存在：${target.relative}；新建文件请用 write_file`, 'FILE_NOT_FOUND');
      }
      if (info.isDirectory()) {
        return toolFail(`${target.relative} 是目录，edit_file 只能改文件`, 'IS_DIRECTORY');
      }

      const content = await readFile(target.absolute, 'utf8');
      const positions = findAll(content, oldText);

      if (positions.length === 0) {
        return toolFail(
          `在 ${target.relative} 中没有找到 oldText（出现 0 次）。请先用 read_file 确认原文，注意缩进与空白必须完全一致。`,
          'TEXT_NOT_FOUND',
        );
      }
      if (positions.length > 1) {
        const lineList = positions.map((position) => lineNumberAt(content, position)).join(', ');
        return toolFail(
          `oldText 在 ${target.relative} 中出现了 ${positions.length} 次（第 ${lineList} 行），edit_file 要求唯一匹配。` +
            '请在 oldText 中补充更多上下文（例如上一行或下一行）使其唯一，或改用 write_file 整体重写。',
          'TEXT_NOT_UNIQUE',
        );
      }

      const index = positions[0]!;
      const startLine = lineNumberAt(content, index);
      const endLine = startLine + countNewlines(oldText);
      const updated = content.slice(0, index) + newText + content.slice(index + oldText.length);
      const before = await ctx.snapshot?.(target.relative);
      await writeFile(target.absolute, updated, 'utf8');

      const updatedLines = updated.split(/\r?\n/);
      if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] === '') updatedLines.pop();
      const context = renderContext(
        updatedLines,
        startLine,
        startLine + countNewlines(newText),
        updatedLines.length,
      );

      return withEffect(
        toolOk(
          [
            `已在 ${target.relative} 替换第 ${startLine}-${endLine} 行（oldText 唯一命中）。`,
            '替换后附近内容：',
            context,
          ].join('\n'),
          { path: target.relative, startLine, endLine },
        ),
        {
          type: 'edit',
          path: target.relative,
          bytes: Buffer.byteLength(updated, 'utf8'),
          overwritten: true,
          ...(before ? { beforeSha256: before.sha256, snapshot: before.snapshot } : {}),
          afterSha256: sha256Hex(updated),
        },
      );
    } catch (error) {
      if (error instanceof SafePathError) return toolFail(error.message, error.code);
      const reason = error instanceof Error ? error.message : String(error);
      return toolFail(`编辑失败：${reason}`, 'EDIT_FAILED');
    }
  },
});
