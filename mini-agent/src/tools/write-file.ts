/**
 * write_file 工具：新建文件（默认不覆盖已存在文件）。
 *
 * 一句话功能：把 content 写入沙箱内指定路径，自动创建父目录。
 * 参数：path（必填）；content（必填，可为空串表示创建空文件）；overwrite（默认 false，必须显式为 true 才覆盖）。
 * 返回：写入的相对路径、字节数与行数。
 * 失败情况：路径越界、目标是已存在文件且 overwrite !== true、目标是目录、写入失败，均返回 ok=false；
 *          已存在时会提示改用 edit_file 做局部修改。
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { defineTool, sha256Hex, toolFail, toolOk, withEffect } from './base.js';
import { SafePathError, resolveSafePath } from './fs-path.js';

export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    '把内容写入沙箱内的文件，自动创建父目录；文件已存在时必须显式传 overwrite=true 才会覆盖（局部修改请用 edit_file）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径，相对沙箱根目录' },
      content: { type: 'string', description: '要写入的完整内容' },
      overwrite: { type: 'boolean', description: '文件已存在时是否覆盖，默认 false' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  todo: [
    '新建文件或按需整体覆盖文件，用于产出代码、配置、文档等。',
    '第一步：解析 path 到沙箱内绝对路径，越界直接失败。',
    '第二步：检查目标是否存在；已存在且 overwrite !== true 时报错并提示改用 edit_file。',
    '第三步：递归创建父目录后写入 UTF-8 内容。',
    '第四步：返回相对路径、字节数与行数，便于模型确认写入规模。',
    '边界：单次写整个文件，不做局部修改、不做二进制写入；覆盖会把原内容整体丢弃。',
    '失败情况：路径越界、已存在但未开 overwrite、目标是目录、磁盘写入失败，均返回 ok=false。',
  ],
  async run(args, ctx) {
    try {
      const target = resolveSafePath(String(args['path'] ?? ''), ctx.rootDir);
      const content = args['content'];
      if (typeof content !== 'string') {
        return toolFail('content 必须是字符串（写空文件请传 ""）', 'CONTENT_INVALID');
      }
      const overwrite = args['overwrite'] === true || args['overwrite'] === 'true';

      let existing;
      try {
        existing = await stat(target.absolute);
      } catch {
        existing = null;
      }

      if (existing) {
        if (existing.isDirectory()) {
          return toolFail(`${target.relative} 是一个目录，不能当作文件写入`, 'IS_DIRECTORY');
        }
        if (!overwrite) {
          return toolFail(
            `文件已存在：${target.relative}。如需局部修改请改用 edit_file；确认要整体覆盖请传 overwrite=true。`,
            'FILE_EXISTS',
          );
        }
      }

      const before = existing ? await ctx.snapshot?.(target.relative) : undefined;
      await mkdir(path.dirname(target.absolute), { recursive: true });
      await writeFile(target.absolute, content, 'utf8');

      const bytes = Buffer.byteLength(content, 'utf8');
      const contentLines = content.split('\n');
      if (contentLines.length > 0 && contentLines[contentLines.length - 1] === '') contentLines.pop();
      const lineCount = content === '' ? 0 : contentLines.length;
      return withEffect(
        toolOk(
          `已写入 ${target.relative}：${bytes} 字节 / ${lineCount} 行${existing ? '（已覆盖原文件）' : '（新建文件）'}`,
          { path: target.relative, bytes, lineCount, overwritten: existing !== null },
        ),
        {
          type: 'fs.write',
          path: target.relative,
          bytes,
          overwritten: existing !== null,
          ...(before ? { beforeSha256: before.sha256, snapshot: before.snapshot } : {}),
          afterSha256: sha256Hex(content),
        },
      );
    } catch (error) {
      if (error instanceof SafePathError) return toolFail(error.message, error.code);
      const reason = error instanceof Error ? error.message : String(error);
      return toolFail(`写入失败：${reason}`, 'WRITE_FAILED');
    }
  },
});
