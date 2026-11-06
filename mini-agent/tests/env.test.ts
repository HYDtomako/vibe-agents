/**
 * .env 加载器测试：解析规则（注释/空行/export/引号/CRLF/非法行）、
 * 文件缺失静默跳过、环境变量优先级、返回值不含值。
 *
 * 全部在 os.tmpdir() 下自建目录与 .env 并清理，不读仓库根的 .env，不联网。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, it } from 'node:test';

import { ENV_FILE_NAME, loadEnv } from '../src/env.js';

let baseDir = '';
let caseNo = 0;

before(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'mini-agent-env-'));
});

after(async () => {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
});

/** 每个用例一个独立目录；file 是纯 ASCII 构造的固件，与仓库根 .env 无关 */
async function writeEnv(content: string, filename = ENV_FILE_NAME): Promise<string> {
  caseNo += 1;
  const dir = path.join(baseDir, `case-${caseNo}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), content, 'utf8');
  return dir;
}

/** 只有目录、没有 .env 的空目录 */
async function emptyDir(): Promise<string> {
  caseNo += 1;
  const dir = path.join(baseDir, `empty-${caseNo}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('loadEnv：解析规则', () => {
  it('正常解析：key=value 写入目标环境，返回路径与键名', async () => {
    const dir = await writeEnv('API_KEY=value-one\nMODEL=demo-model\n');
    const env: NodeJS.ProcessEnv = {};

    const result = await loadEnv({ cwd: dir, env });

    assert.equal(result.path, path.join(dir, ENV_FILE_NAME));
    assert.deepEqual(result.loaded, ['API_KEY', 'MODEL']);
    assert.deepEqual(result.skipped, []);
    assert.equal(env['API_KEY'], 'value-one');
    assert.equal(env['MODEL'], 'demo-model');
  });

  it('忽略空行与 # 注释行（含行首空白）', async () => {
    const dir = await writeEnv('\n# 顶部注释\n   # 缩进注释\nA=1\n\n   \nB=2\n');
    const env: NodeJS.ProcessEnv = {};

    const result = await loadEnv({ cwd: dir, env });

    assert.deepEqual(result.loaded, ['A', 'B']);
    assert.equal(env['A'], '1');
    assert.equal(env['B'], '2');
    assert.deepEqual(Object.keys(env), ['A', 'B'], '注释与空行不产生键');
  });

  it('支持 export 前缀', async () => {
    const dir = await writeEnv('export A=1\nexport\tB=two\n');
    const env: NodeJS.ProcessEnv = {};

    const result = await loadEnv({ cwd: dir, env });

    assert.deepEqual(result.loaded, ['A', 'B']);
    assert.equal(env['A'], '1');
    assert.equal(env['B'], 'two');
  });

  it('成对引号去掉引号，引号内的 # 与 = 保留；不成对的原样保留', async () => {
    const dir = await writeEnv(
      [
        'DQ="a b#c=d"',
        "SQ='x = y # z'",
        'EMPTY=""',
        'UNPAIRED="only-left',
        "SINGLE='tail",
      ].join('\n'),
    );
    const env: NodeJS.ProcessEnv = {};

    const result = await loadEnv({ cwd: dir, env });

    assert.deepEqual(result.loaded, ['DQ', 'SQ', 'EMPTY', 'UNPAIRED', 'SINGLE']);
    assert.equal(env['DQ'], 'a b#c=d');
    assert.equal(env['SQ'], 'x = y # z');
    assert.equal(env['EMPTY'], '');
    assert.equal(env['UNPAIRED'], '"only-left', '没有闭合引号时不吞正文');
    assert.equal(env['SINGLE'], "'tail");
  });

  it('兼容 CRLF：值不带行尾 \\r', async () => {
    const dir = await writeEnv('A=1\r\nB=two\r\nC="three"\r\n');
    const env: NodeJS.ProcessEnv = {};

    const result = await loadEnv({ cwd: dir, env });

    assert.deepEqual(result.loaded, ['A', 'B', 'C']);
    assert.equal(env['A'], '1');
    assert.equal(env['B'], 'two');
    assert.equal(env['C'], 'three');
    assert.ok(!String(env['B']).includes('\r'), 'CRLF 只能在行尾被吃掉');
  });

  it('没有 = 的行与非法 KEY 的行都忽略，不报错', async () => {
    const dir = await writeEnv(
      ['ONLY_KEY', '1BAD=x', 'BAD-KEY=y', 'BAD KEY=z', '=nokey', 'GOOD=ok'].join('\n'),
    );
    const env: NodeJS.ProcessEnv = {};

    const result = await loadEnv({ cwd: dir, env });

    assert.deepEqual(result.loaded, ['GOOD']);
    assert.deepEqual(Object.keys(env), ['GOOD'], '非法行的键名也不进环境');
    assert.equal(env['GOOD'], 'ok');
  });

  it('一行只按第一个 = 切分，值里允许 =', async () => {
    const dir = await writeEnv('TOKEN=a=b=c\n');
    const env: NodeJS.ProcessEnv = {};

    await loadEnv({ cwd: dir, env });

    assert.equal(env['TOKEN'], 'a=b=c');
  });

  it('同名键后者覆盖前者，键顺序保留首次出现的位置', async () => {
    const dir = await writeEnv('A=1\nB=2\nA=3\n');
    const env: NodeJS.ProcessEnv = {};

    const result = await loadEnv({ cwd: dir, env });

    assert.deepEqual(result.loaded, ['A', 'B']);
    assert.equal(env['A'], '3');
    assert.equal(env['B'], '2');
  });

  it('KEY 与未加引号的值两侧空白会被去掉，引号内的空白保留', async () => {
    const dir = await writeEnv('  A  =  1  \nB= "  inner  " \n');
    const env: NodeJS.ProcessEnv = {};

    const result = await loadEnv({ cwd: dir, env });

    assert.deepEqual(result.loaded, ['A', 'B']);
    assert.equal(env['A'], '1');
    assert.equal(env['B'], '  inner  ');
  });

  it('支持自定义文件名，并去掉文件开头的 BOM', async () => {
    const dir = await writeEnv('\uFEFFA=1\nB=2\n', '.env.custom');
    const env: NodeJS.ProcessEnv = {};

    const result = await loadEnv({ cwd: dir, env, filename: '.env.custom' });

    assert.equal(result.path, path.join(dir, '.env.custom'));
    assert.deepEqual(result.loaded, ['A', 'B'], 'BOM 不能粘在第一个键名上');
    assert.equal(env['A'], '1');
  });
});

describe('loadEnv：文件缺失与优先级', () => {
  it('文件缺失时静默跳过：path=null、loaded 为空、环境不变', async () => {
    const dir = await emptyDir();
    const env: NodeJS.ProcessEnv = { KEEP: 'kept' };

    const result = await loadEnv({ cwd: dir, env });

    assert.deepEqual(result, { path: null, loaded: [], skipped: [] });
    assert.deepEqual(env, { KEEP: 'kept' });
  });

  it('目录本身不存在时同样静默跳过，不抛错', async () => {
    const env: NodeJS.ProcessEnv = {};

    const result = await loadEnv({ cwd: path.join(baseDir, 'no-such-dir', 'deeper'), env });

    assert.equal(result.path, null);
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(env, {});
  });

  it('已存在的键不覆盖，并记入 skipped', async () => {
    const dir = await writeEnv('API_KEY=from-file\nMODEL=from-file\nNEW=from-file\n');
    const env: NodeJS.ProcessEnv = { API_KEY: 'from-env' };

    const result = await loadEnv({ cwd: dir, env });

    assert.equal(env['API_KEY'], 'from-env', '真实环境变量优先');
    assert.deepEqual(result.skipped, ['API_KEY']);
    assert.deepEqual(result.loaded, ['MODEL', 'NEW']);
    assert.equal(env['MODEL'], 'from-file');
  });

  it('已存在但值为空串的键同样不覆盖', async () => {
    const dir = await writeEnv('API_KEY=from-file\n');
    const env: NodeJS.ProcessEnv = { API_KEY: '' };

    const result = await loadEnv({ cwd: dir, env });

    assert.equal(env['API_KEY'], '');
    assert.deepEqual(result.skipped, ['API_KEY']);
    assert.deepEqual(result.loaded, []);
  });

  it('默认写入 process.env：已存在的真实环境变量不被覆盖', async () => {
    const keepKey = 'MINI_AGENT_ENV_TEST_KEEP';
    const fillKey = 'MINI_AGENT_ENV_TEST_FILL';
    process.env[keepKey] = 'from-env';
    delete process.env[fillKey];

    try {
      const dir = await writeEnv(`${keepKey}=from-file\n${fillKey}=from-file\n`);

      const result = await loadEnv({ cwd: dir });

      assert.equal(process.env[keepKey], 'from-env');
      assert.equal(process.env[fillKey], 'from-file');
      assert.deepEqual(result.skipped, [keepKey]);
      assert.deepEqual(result.loaded, [fillKey]);
    } finally {
      delete process.env[keepKey];
      delete process.env[fillKey];
    }
  });

  it('返回值只含键名与路径，不含变量值', async () => {
    const dir = await writeEnv('FIRST_KEY=value-aaa-111\nSECOND_KEY=value-bbb-222\n');
    const env: NodeJS.ProcessEnv = {};

    const result = await loadEnv({ cwd: dir, env });
    const serialized = JSON.stringify(result);

    assert.ok(serialized.includes('FIRST_KEY'), '键名可以出现在返回值里');
    assert.ok(!serialized.includes('value-aaa-111'));
    assert.ok(!serialized.includes('value-bbb-222'));
    // 值只写进目标环境
    assert.equal(env['FIRST_KEY'], 'value-aaa-111');
    assert.equal(env['SECOND_KEY'], 'value-bbb-222');
  });
});
