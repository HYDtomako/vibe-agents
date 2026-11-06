/**
 * SessionStore 测试：会话读写、列出、删除、id 规范化、路径穿越防护、
 * 损坏文件恢复、原子写。
 *
 * 全部在 os.tmpdir() 下跑，注入固定时钟，不写项目目录、不联网。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { MAX_SESSION_ID_LENGTH, SessionStore, normalizeSessionId } from '../src/session.js';
import type { Message } from '../src/types.js';

let baseDir = '';
let clock = Date.parse('2026-02-01T09:00:00Z');

const tick = (ms = 60_000): void => {
  clock += ms;
};

function freshStore(name: string): SessionStore {
  return new SessionStore({ dir: path.join(baseDir, name), now: () => clock });
}

const userMessage = (content: string): Message => ({ role: 'user', content, createdAt: clock });
const assistantMessage = (content: string): Message => ({ role: 'assistant', content, createdAt: clock });

before(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'mini-agent-session-'));
});

after(async () => {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
});

describe('SessionStore：读写', () => {
  it('save/load 往返：消息完整，createdAt 不变，updatedAt 前进', async () => {
    const store = freshStore('roundtrip');
    const first = await store.save('a', [userMessage('你好'), assistantMessage('你好，有什么可以帮你')]);
    assert.equal(first.id, 'a');
    assert.equal(first.messages.length, 2);

    tick();
    const second = await store.save('a', [userMessage('第二句')]);
    assert.equal(second.createdAt, first.createdAt, 'createdAt 沿用第一次写入的时间');
    assert.equal(second.updatedAt, clock);
    assert.ok(second.updatedAt > first.updatedAt);

    const loaded = await store.load('a');
    assert.equal(loaded.id, 'a');
    assert.deepEqual(
      loaded.messages.map((message) => [message.role, message.content]),
      [['user', '第二句']],
    );
    assert.equal(loaded.createdAt, first.createdAt);
  });

  it('新 SessionStore 实例（模拟重启）能 load 回历史', async () => {
    const dir = path.join(baseDir, 'restart');
    const before = new SessionStore({ dir, now: () => clock });
    await before.save('restart-me', [userMessage('重启前的提问'), assistantMessage('重启前的回答')]);

    const after2 = new SessionStore({ dir, now: () => clock });
    const state = await after2.load('restart-me');
    assert.equal(state.messages.length, 2);
    assert.equal(state.messages[0]!.content, '重启前的提问');
    assert.equal(state.messages[1]!.content, '重启前的回答');
  });

  it('list() 按 updatedAt 倒序并给出消息条数', async () => {
    const store = freshStore('list');
    await store.save('old', [userMessage('一')]);
    tick();
    await store.save('new', [userMessage('二'), assistantMessage('三')]);
    tick();
    await store.save('middle', []);

    const list = await store.list();
    assert.deepEqual(
      list.map((item) => item.id),
      ['middle', 'new', 'old'],
    );
    assert.deepEqual(
      list.map((item) => item.messageCount),
      [0, 2, 1],
    );
  });

  it('delete() 真删文件；删不存在的会话返回 false', async () => {
    const store = freshStore('delete');
    await store.save('gone', [userMessage('待删')]);
    assert.equal(await store.exists('gone'), true);

    assert.equal(await store.delete('gone'), true);
    assert.equal(await store.exists('gone'), false);
    assert.equal(await store.delete('gone'), false);
    assert.deepEqual(await store.list(), []);
  });

  it('create() 幂等：已存在的会话不会被空历史覆盖', async () => {
    const store = freshStore('create');
    const created = await store.create('keep');
    assert.deepEqual(created.messages, []);

    await store.save('keep', [userMessage('别丢')]);
    const again = await store.create('keep');
    assert.equal(again.messages.length, 1);
    assert.equal(again.messages[0]!.content, '别丢');
  });

  it('目录不存在时 load 返回空会话，不抛异常', async () => {
    const store = freshStore('nowhere');
    const state = await store.load('missing');
    assert.equal(state.id, 'missing');
    assert.deepEqual(state.messages, []);
    assert.equal(state.createdAt, clock);
  });

  it('load 只保留合法消息条目，畸形数据被丢弃', async () => {
    const dir = path.join(baseDir, 'sanitize');
    const store = new SessionStore({ dir, now: () => clock });
    await store.save('mixed', []);
    await writeFile(
      path.join(dir, 'mixed.json'),
      JSON.stringify({
        id: 'mixed',
        messages: [
          { role: 'user', content: '正常一条' },
          { role: 'bogus', content: '角色非法' },
          { role: 'assistant' },
          42,
          null,
        ],
        createdAt: clock,
        updatedAt: clock,
      }),
      'utf8',
    );

    const state = await store.load('mixed');
    assert.deepEqual(
      state.messages.map((message) => message.content),
      ['正常一条'],
    );
  });
});

describe('SessionStore：id 规范化与路径安全', () => {
  it('非法字符替换为 _，长度截断到 64', () => {
    assert.equal(normalizeSessionId('a b/c'), 'a_b_c');
    assert.equal(normalizeSessionId('会话 1'), '_1');
    const long = normalizeSessionId('x'.repeat(100));
    assert.equal(long.length, MAX_SESSION_ID_LENGTH);
    assert.equal(normalizeSessionId('...'), '');
  });

  it('空 id 自动生成 s-<timestamp>-<rand4>', () => {
    const store = freshStore('auto-id');
    const first = store.resolveId();
    const second = store.resolveId('   ');
    assert.match(first, /^s-\d+-[0-9a-f]{4}$/);
    assert.match(second, /^s-\d+-[0-9a-f]{4}$/);
    assert.notEqual(first, second);
  });

  it('合法 id 原样保留', () => {
    const store = freshStore('keep-id');
    assert.equal(store.resolveId('cli'), 'cli');
    assert.equal(store.resolveId('  sess_1.test  '), 'sess_1.test');
    assert.equal(store.resolveId('s-2026-02-01'), 's-2026-02-01');
  });

  it('.. 与绝对路径都无法逃出会话目录', async () => {
    const dir = path.join(baseDir, 'traversal');
    const store = new SessionStore({ dir, now: () => clock });

    const raws = ['..', '../', '../../etc/passwd', '/etc/passwd', 'C:\\Windows\\win.ini', '..\\..\\evil'];
    for (const raw of raws) {
      const id = store.resolveId(raw);
      assert.notEqual(id, raw);
      assert.ok(!id.includes('/'), `id 不应含路径分隔符：${id}`);
      assert.ok(!id.includes('\\'), `id 不应含反斜杠：${id}`);
      assert.ok(!id.includes('..'), `id 不应含 ..：${id}`);
      await store.save(id, [userMessage(raw)]);
    }

    const names = (await readdir(dir)).sort();
    assert.equal(names.length, raws.length);
    for (const name of names) {
      // 每个会话文件都直接躺在 dir 下，没有子目录、没有越界路径
      assert.equal(path.dirname(path.join(dir, name)), dir);
      assert.match(name, /^[A-Za-z0-9_.-]+\.json$/);
    }
    // 会话目录之外没有多出文件：父目录只有这些子目录本身
    const parentNames = await readdir(baseDir);
    assert.ok(parentNames.includes('traversal'));
    assert.ok(!parentNames.includes('etc_passwd.json'));
  });
});

describe('SessionStore：损坏文件与原子写', () => {
  it('损坏 JSON 被改名为 .corrupt-<ts>，load 返回空会话', async () => {
    const dir = path.join(baseDir, 'corrupt');
    const store = new SessionStore({ dir, now: () => clock });
    await store.save('broken', [userMessage('本来有内容')]);
    await writeFile(path.join(dir, 'broken.json'), '{ 这不是 JSON', 'utf8');

    const state = await store.load('broken');
    assert.equal(state.id, 'broken');
    assert.deepEqual(state.messages, []);

    const names = await readdir(dir);
    assert.ok(!names.includes('broken.json'), '损坏文件应已改名');
    assert.ok(
      names.some((name) => name.startsWith('broken.json.corrupt-')),
      `应留下 .corrupt-<ts> 留档，实际：${names.join(', ')}`,
    );

    // 留档之后继续用同一个 id 读写是正常会话
    const saved = await store.save('broken', [userMessage('重新开始')]);
    assert.equal(saved.messages.length, 1);
  });

  it('缺少 messages 数组同样按损坏处理', async () => {
    const dir = path.join(baseDir, 'corrupt-shape');
    const store = new SessionStore({ dir, now: () => clock });
    await store.save('shape', []);
    await writeFile(path.join(dir, 'shape.json'), JSON.stringify({ id: 'shape' }), 'utf8');

    const state = await store.load('shape');
    assert.deepEqual(state.messages, []);
    assert.ok((await readdir(dir)).some((name) => name.startsWith('shape.json.corrupt-')));
  });

  it('原子写：写完不留 .tmp 残留，文件内容可直接 JSON.parse', async () => {
    const dir = path.join(baseDir, 'atomic');
    const store = new SessionStore({ dir, now: () => clock });
    await store.save('atomic', [userMessage('原子写第一条')]);
    await store.save('atomic', [userMessage('原子写第二条'), assistantMessage('回执')]);

    const names = await readdir(dir);
    assert.deepEqual(names, ['atomic.json'], `不应残留临时文件，实际：${names.join(', ')}`);

    const payload = JSON.parse(await readFile(path.join(dir, 'atomic.json'), 'utf8')) as {
      id: string;
      messages: Message[];
      createdAt: number;
      updatedAt: number;
    };
    assert.equal(payload.id, 'atomic');
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.messages[0]!.content, '原子写第二条');
    assert.equal(typeof payload.createdAt, 'number');
    assert.equal(typeof payload.updatedAt, 'number');
  });
});
