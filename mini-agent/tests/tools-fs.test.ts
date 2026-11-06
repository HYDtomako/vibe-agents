/**
 * 文件工具测试：read_file / grep / edit_file / write_file。
 *
 * 全部在 os.tmpdir() 的临时目录里跑，不写项目目录、不联网；
 * 每个用例用独立子目录，结束后统一清理。
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { editFileTool } from '../src/tools/edit-file.js';
import { grepTool } from '../src/tools/grep.js';
import { readFileTool } from '../src/tools/read-file.js';
import { writeFileTool } from '../src/tools/write-file.js';
import type { ToolResult } from '../src/types.js';

let sandbox = '';
let outside = '';

function ctx(root: string): { toolName: string; rootDir: string } {
  return { toolName: 'fs', rootDir: root };
}

async function runRead(args: Record<string, unknown>): Promise<ToolResult> {
  return readFileTool.run(args, ctx(sandbox));
}

async function runWrite(args: Record<string, unknown>): Promise<ToolResult> {
  return writeFileTool.run(args, ctx(sandbox));
}

async function runEdit(args: Record<string, unknown>): Promise<ToolResult> {
  return editFileTool.run(args, ctx(sandbox));
}

async function runGrep(args: Record<string, unknown>): Promise<ToolResult> {
  return grepTool.run(args, ctx(sandbox));
}

function lines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_v, index) => `${prefix} ${index + 1}`).join('\n');
}

before(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'mini-agent-fs-'));
  outside = await mkdtemp(path.join(os.tmpdir(), 'mini-agent-outside-'));
  await writeFile(path.join(sandbox, 'numbers.txt'), `${lines(10)}\n`, 'utf8');
  await writeFile(path.join(sandbox, 'long.txt'), `${lines(250)}\n`, 'utf8');
  await mkdir(path.join(sandbox, 'src'), { recursive: true });
  await writeFile(path.join(sandbox, 'src', 'app.ts'), 'const needle = 1;\nconst other = 2;\n', 'utf8');
  await mkdir(path.join(sandbox, 'node_modules', 'dep'), { recursive: true });
  await writeFile(path.join(sandbox, 'node_modules', 'dep', 'index.ts'), 'const needle = 3;\n', 'utf8');
  await writeFile(path.join(outside, 'secret.txt'), 'top secret\n', 'utf8');
});

after(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  if (outside) await rm(outside, { recursive: true, force: true });
});

describe('read_file', () => {
  it('按 offset/limit 返回带行号的行范围', async () => {
    const result = await runRead({ path: 'numbers.txt', offset: 3, limit: 2 });
    assert.equal(result.ok, true);
    assert.match(result.output, /共 10 行/);
    assert.match(result.output, /^ {3}3\| line 3$/m);
    assert.match(result.output, /^ {3}4\| line 4$/m);
    assert.doesNotMatch(result.output, /line 5/);
    // 后面还有行没读，因此仍提示截断，并给出续读的 offset
    assert.match(result.output, /已截断，共 10 行/);
    assert.match(result.output, /offset=5/);
  });

  it('默认 limit=200，超出时明确写出「已截断，共 N 行」', async () => {
    const result = await runRead({ path: 'long.txt' });
    assert.equal(result.ok, true);
    assert.match(result.output, /已截断，共 250 行/);
    assert.equal((result.output.match(/\| line /g) ?? []).length, 200);
  });

  it('limit 超过上限时按 2000 截断（这里是 250 行全部返回）', async () => {
    const result = await runRead({ path: 'long.txt', limit: 5000 });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.output, /已截断/);
    assert.equal((result.output.match(/\| line /g) ?? []).length, 250);
  });

  it('文件不存在时返回 ok=false 且原因可读', async () => {
    const result = await runRead({ path: 'nope.txt' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'FILE_NOT_FOUND');
    assert.match(result.output, /文件不存在/);
  });

  it('目录不能被当作文件读取', async () => {
    const result = await runRead({ path: 'src' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'IS_DIRECTORY');
  });

  it('offset 超出总行数时报错', async () => {
    const result = await runRead({ path: 'numbers.txt', offset: 99 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'OFFSET_OUT_OF_RANGE');
  });

  it('疑似二进制文件被拒绝', async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x41]);
    await writeFile(path.join(sandbox, 'bin.dat'), binary);
    const result = await runRead({ path: 'bin.dat' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'BINARY_FILE');
  });
});

describe('grep', () => {
  it('命中时输出「相对路径:行号: 行内容」并汇总统计', async () => {
    const result = await runGrep({ pattern: 'needle' });
    assert.equal(result.ok, true);
    assert.match(result.output, /src\/app\.ts:1: const needle = 1;/);
    assert.match(result.output, /匹配 \d+ 处，涉及 \d+ 个文件/);
  });

  it('默认跳过 node_modules', async () => {
    const result = await runGrep({ pattern: 'needle' });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.output, /node_modules/);
  });

  it('指定 path 后只搜该目录', async () => {
    const result = await runGrep({ pattern: 'other', path: 'src' });
    assert.equal(result.ok, true);
    assert.match(result.output, /src\/app\.ts:2:/);
    assert.match(result.output, /1 个文件/);
  });

  it('无命中时 ok=true 并说明没有找到', async () => {
    const result = await runGrep({ pattern: '肯定不存在的字符串xyz' });
    assert.equal(result.ok, true);
    assert.match(result.output, /没有找到匹配/);
  });

  it('regex=true 时按正则匹配', async () => {
    const result = await runGrep({ pattern: 'const\\s+needle\\s*=', regex: true });
    assert.equal(result.ok, true);
    assert.match(result.output, /src\/app\.ts:1:/);
  });

  it('ignoreCase=true 时忽略大小写', async () => {
    const insensitive = await runGrep({ pattern: 'NEEDLE', ignoreCase: true });
    const sensitive = await runGrep({ pattern: 'NEEDLE' });
    assert.match(insensitive.output, /src\/app\.ts:1:/);
    assert.match(sensitive.output, /没有找到匹配/);
  });

  it('glob 过滤文件名', async () => {
    const hit = await runGrep({ pattern: 'needle', glob: '*.ts' });
    const miss = await runGrep({ pattern: 'needle', glob: '*.md' });
    assert.match(hit.output, /src\/app\.ts:1:/);
    assert.match(miss.output, /没有找到匹配/);
  });

  it('超过 maxResults 时截断并说明', async () => {
    const result = await runGrep({ pattern: 'line', maxResults: 3 });
    assert.equal(result.ok, true);
    assert.match(result.output, /已截断：只显示前 3 条/);
  });
});

describe('edit_file', () => {
  it('唯一命中时替换成功，并给出行区间与上下文', async () => {
    const file = path.join(sandbox, 'edit-ok.txt');
    await writeFile(file, 'alpha\nbeta\ngamma\n', 'utf8');

    const result = await runEdit({ path: 'edit-ok.txt', oldText: 'beta', newText: 'BETA' });
    assert.equal(result.ok, true);
    assert.match(result.output, /第 2-2 行/);
    assert.match(result.output, /BETA/);
    assert.equal(await readFile(file, 'utf8'), 'alpha\nBETA\ngamma\n');
  });

  it('oldText 出现 0 次时失败', async () => {
    const result = await runEdit({ path: 'edit-ok.txt', oldText: '不存在的片段', newText: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'TEXT_NOT_FOUND');
    assert.match(result.output, /出现 0 次/);
  });

  it('oldText 出现多次时失败，并报出次数与行号', async () => {
    await writeFile(path.join(sandbox, 'edit-dup.txt'), 'dup\na\ndup\n', 'utf8');
    const result = await runEdit({ path: 'edit-dup.txt', oldText: 'dup', newText: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'TEXT_NOT_UNIQUE');
    assert.match(result.output, /出现了 2 次/);
    assert.match(result.output, /第 1, 3 行/);
    assert.match(result.output, /补充更多上下文/);
    // 文件没被改动
    assert.equal(await readFile(path.join(sandbox, 'edit-dup.txt'), 'utf8'), 'dup\na\ndup\n');
  });

  it('oldText 为空串时失败', async () => {
    const result = await runEdit({ path: 'numbers.txt', oldText: '', newText: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'OLD_TEXT_EMPTY');
  });
});

describe('write_file', () => {
  it('新建文件并自动创建父目录，返回字节数与行数', async () => {
    const result = await runWrite({ path: 'new/deep/file.txt', content: 'hello\nworld\n' });
    assert.equal(result.ok, true);
    assert.match(result.output, /12 字节 \/ 2 行/);
    assert.equal(await readFile(path.join(sandbox, 'new', 'deep', 'file.txt'), 'utf8'), 'hello\nworld\n');
  });

  it('已存在且未传 overwrite 时失败，并提示改用 edit_file', async () => {
    await writeFile(path.join(sandbox, 'exists.txt'), 'original', 'utf8');
    const result = await runWrite({ path: 'exists.txt', content: 'changed' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'FILE_EXISTS');
    assert.match(result.output, /edit_file/);
    assert.equal(await readFile(path.join(sandbox, 'exists.txt'), 'utf8'), 'original');
  });

  it('overwrite=true 时成功覆盖', async () => {
    const result = await runWrite({ path: 'exists.txt', content: 'changed', overwrite: true });
    assert.equal(result.ok, true);
    assert.match(result.output, /已覆盖原文件/);
    assert.equal(await readFile(path.join(sandbox, 'exists.txt'), 'utf8'), 'changed');
  });
});

describe('沙箱越界', () => {
  it('用 .. 跳出根目录被拒绝', async () => {
    const result = await runRead({ path: '../escape.txt' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'PATH_ESCAPE');
    assert.match(result.output, /越出允许的根目录/);
  });

  it('写文件到根目录之外被拒绝', async () => {
    const result = await runWrite({ path: '../escape.txt', content: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'PATH_ESCAPE');
    assert.equal(existsSync(path.join(outside, '..', 'escape.txt')), false);
  });

  it('绝对路径指向根目录之外被拒绝', async () => {
    const absolute = path.join(outside, 'secret.txt');
    const result = await runRead({ path: absolute });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'PATH_ESCAPE');
  });

  it('Windows 反斜杠与混合分隔符会被归一化', async () => {
    const result = await runRead({ path: 'src\\app.ts' });
    assert.equal(result.ok, true);
    assert.match(result.output, /const needle = 1;/);
  });

  it('符号链接指向根目录之外时被拒绝（平台不支持则跳过）', async (t) => {
    const linkPath = path.join(sandbox, 'link-out');
    let created = false;
    // Windows 上目录 junction 不需要管理员权限，优先尝试
    for (const type of process.platform === 'win32' ? (['junction', 'dir'] as const) : (['dir'] as const)) {
      try {
        await symlink(outside, linkPath, type);
        created = true;
        break;
      } catch {
        // 换下一种类型再试
      }
    }
    if (!created) {
      t.skip('当前平台/权限不支持创建符号链接');
      return;
    }
    const result = await runRead({ path: 'link-out/secret.txt' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'PATH_SYMLINK_ESCAPE');
  });
});
