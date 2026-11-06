/**
 * 多 session 隔离测试：用假模型注入，两个会话交替 run，验证
 *   1. 消息历史互不可见（SessionStore 每会话一个文件）；
 *   2. todo 按 ctx.sessionId 分区，A 的待办不出现在 B 的列表里；
 *   3. 记忆是跨会话的用户档案：全局单文件，A 写入的记忆在 B 也能召回；
 *   4. 某会话工具连续失败熔断不影响另一个会话（失败计数按 sessionId 键控）；
 *   5. trace 的 sessionId 透传、error 终止也会落盘。
 *
 * 全部在 os.tmpdir() 下跑，不联网、不写真实用户目录。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { AgentLoop } from '../src/loop.js';
import { MemoryStore } from '../src/memory.js';
import { SessionStore } from '../src/session.js';
import { defineTool, toolFail } from '../src/tools/base.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTodoTool } from '../src/tools/todo.js';
import type { Message, ModelClient, ModelResponse } from '../src/types.js';

let baseDir = '';

/** 按脚本构建响应：拿到的是本轮发给模型的完整消息 */
type Responder = (messages: Message[]) => ModelResponse;

class FakeModel implements ModelClient {
  readonly calls: Message[][] = [];

  constructor(private readonly respond: Responder) {}

  async chat(messages: Message[]): Promise<ModelResponse> {
    this.calls.push(messages.map((message) => ({ ...message })));
    return this.respond(messages);
  }
}

function lastUserText(messages: Message[]): string {
  const user = [...messages].reverse().find((message) => message.role === 'user');
  return user?.content ?? '';
}

function store(name: string): SessionStore {
  return new SessionStore({ dir: path.join(baseDir, name) });
}

/** 解析 loop 回灌的 tool 消息：外层是 { ok, output }，内层才是工具自己的 JSON */
function parseToolPayload(message: Message): { ok: boolean; output: string } {
  assert.equal(message.role, 'tool');
  return JSON.parse(message.content) as { ok: boolean; output: string };
}

before(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'mini-agent-isolation-'));
});

after(async () => {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
});

describe('会话隔离：消息历史', () => {
  it('A 与 B 交替 run，历史互不可见，且各自落盘到自己的文件', async () => {
    const sessions = store('history');
    const model = new FakeModel((messages) => ({
      content: `回复：${lastUserText(messages)}`,
      toolCalls: [],
    }));
    const loop = new AgentLoop({ model, registry: new ToolRegistry(), sessions, sessionId: 'A' });

    await loop.run('A 的第一句');
    await loop.run('B 的第一句', { sessionId: 'B' });
    await loop.run('A 的第二句');

    const a = await sessions.load('A');
    const b = await sessions.load('B');
    assert.deepEqual(
      a.messages.map((message) => message.content),
      ['A 的第一句', '回复：A 的第一句', 'A 的第二句', '回复：A 的第二句'],
    );
    assert.deepEqual(
      b.messages.map((message) => message.content),
      ['B 的第一句', '回复：B 的第一句'],
    );
    assert.ok(a.messages.every((message) => message.role !== 'system'), 'system 提示不落盘');

    // 发给模型的上下文也要隔离：B 的第二次调用看不到 A 的历史，反之亦然
    const bCall = model.calls[1]!;
    assert.ok(bCall.some((message) => message.content === 'B 的第一句'));
    assert.ok(!bCall.some((message) => message.content.includes('A 的第一句')));
    const aSecondCall = model.calls[2]!;
    assert.ok(aSecondCall.some((message) => message.content === 'A 的第一句'), 'A 续聊能带上自己的历史');
    assert.ok(!aSecondCall.some((message) => message.content.includes('B 的第一句')));
  });

  it('新建 SessionStore 实例（重启式）能 load 回会话历史', async () => {
    const dir = path.join(baseDir, 'restart');
    const first = new SessionStore({ dir });
    const model = new FakeModel((messages) => ({ content: `回复：${lastUserText(messages)}`, toolCalls: [] }));
    const loop = new AgentLoop({ model, registry: new ToolRegistry(), sessions: first, sessionId: 'persist' });
    await loop.run('重启前说的一句话');

    const restarted = new SessionStore({ dir });
    const state = await restarted.load('persist');
    assert.equal(state.messages.length, 2);
    assert.equal(state.messages[0]!.content, '重启前说的一句话');
    assert.deepEqual(await restarted.list().then((list) => list.map((item) => item.id)), ['persist']);
  });

  it('模型失败（error 终止）也会把本轮消息写回会话', async () => {
    const sessions = store('error-save');
    const failing: ModelClient = {
      async chat() {
        throw new Error('HTTP 500');
      },
    };
    const loop = new AgentLoop({
      model: failing,
      registry: new ToolRegistry(),
      sessions,
      sessionId: 'err',
      retry: { sleep: async () => {} },
    });

    const result = await loop.run('这次一定会失败');
    assert.equal(result.stopReason, 'retry_exhausted');
    const state = await sessions.load('err');
    assert.deepEqual(
      state.messages.map((message) => message.role),
      ['user'],
      '至少把用户输入留下来，便于续聊',
    );
  });
});

describe('会话隔离：todo 与记忆', () => {
  it('todo 按 sessionId 分区：A 的待办不在 B 的列表里', async () => {
    const sessions = store('todo');
    const todo = createTodoTool();
    const registry = new ToolRegistry();
    registry.register(todo.tool);

    const model = new FakeModel((messages) => {
      const last = messages[messages.length - 1]!;
      if (last.role !== 'user') return { content: '好的', toolCalls: [] };
      const input = last.content;
      if (input.startsWith('add:')) {
        return {
          content: '',
          toolCalls: [
            { id: 'add-1', name: 'todo', arguments: JSON.stringify({ action: 'add', text: input.slice(4) }) },
          ],
        };
      }
      return {
        content: '',
        toolCalls: [{ id: 'list-1', name: 'todo', arguments: JSON.stringify({ action: 'list' }) }],
      };
    });
    const loop = new AgentLoop({ model, registry, sessions, sessionId: 'A' });

    await loop.run('add:只属于 A 的待办');
    const bRun = await loop.run('list', { sessionId: 'B' });
    const aRun = await loop.run('list');

    const bPayload = JSON.parse(
      parseToolPayload(bRun.messages.filter((message) => message.role === 'tool').at(-1)!).output,
    ) as {
      count: number;
      items: Array<{ text: string }>;
    };
    const aPayload = JSON.parse(
      parseToolPayload(aRun.messages.filter((message) => message.role === 'tool').at(-1)!).output,
    ) as {
      count: number;
      items: Array<{ text: string }>;
    };

    assert.equal(bPayload.count, 0, 'B 看不到 A 的待办');
    assert.deepEqual(bPayload.items, []);
    assert.equal(aPayload.count, 1);
    assert.equal(aPayload.items[0]!.text, '只属于 A 的待办');

    assert.deepEqual(
      todo.snapshot('A').map((item) => item.text),
      ['只属于 A 的待办'],
    );
    assert.deepEqual(todo.snapshot('B'), []);

    // 旧签名 snapshot() 仍取默认分区（不给 sessionId 时的 '' 分区）
    await todo.tool.run({ action: 'add', text: '默认分区的待办' }, { toolName: 'todo' });
    assert.deepEqual(
      todo.snapshot().map((item) => item.text),
      ['默认分区的待办'],
    );
    assert.deepEqual(
      todo.snapshot('A').map((item) => item.text),
      ['只属于 A 的待办'],
      '默认分区不影响 A 的分区',
    );
  });

  it('记忆全局共享：A 写入的记忆在 B 也能召回，只有一份 cli.md', async () => {
    const sessions = store('memory-global');
    const memoryDir = path.join(baseDir, 'memory-shared');
    const memory = new MemoryStore({ dir: memoryDir });
    const model = new FakeModel((messages) => ({ content: `回复：${lastUserText(messages)}`, toolCalls: [] }));
    const loop = new AgentLoop({ model, registry: new ToolRegistry(), sessions, memory, sessionId: 'A' });

    // 记忆文件固定为 <dir>/cli.md，不随 sessionId 派生
    assert.equal(memory.filePath, path.join(memoryDir, 'cli.md'));

    await memory.append({ text: 'A 的项目代号是火龙果', tag: '项目代号' });

    await loop.run('A 的结论');
    await loop.run('B 的项目代号是什么', { sessionId: 'B' });

    // 两个会话共用同一份记忆文件：A 与 B 的写入都落在 cli.md 里
    const raw = await readFile(memory.filePath, 'utf8');
    assert.match(raw, /A 的项目代号是火龙果/);
    assert.match(raw, /A 的结论/);
    assert.match(raw, /B 的项目代号是什么/);
    assert.deepEqual(await readdir(memoryDir), ['cli.md'], '目录里不应再有按会话派生的记忆文件');

    // 召回跨会话：B 提问时能召回 A 写入的记忆
    const bCall = model.calls[model.calls.length - 1]!;
    const injected = bCall.filter((message) => message.content.startsWith('[相关记忆]'));
    assert.equal(injected.length, 1, 'B 应该召回全局记忆');
    assert.match(injected[0]!.content, /火龙果/, 'A 写的记忆在 B 会话里要能召回');
  });
});

describe('会话隔离：熔断与 trace', () => {
  it('某会话工具连续失败熔断，不影响另一个会话的失败计数', async () => {
    const sessions = store('circuit');
    const alwaysFail = defineTool({
      name: 'broken',
      description: '总是返回确定性失败，用于验证熔断计数按会话隔离',
      parameters: { type: 'object', properties: {} },
      todo: ['永远返回 ok=false 且 retryable=false，让 loop 累计失败次数直至熔断'],
      async run() {
        return toolFail('上游不可用', 'UPSTREAM_DOWN', false);
      },
    });
    const registry = new ToolRegistry();
    registry.register(alwaysFail);

    let callId = 0;
    const model = new FakeModel(() => ({
      content: '',
      toolCalls: [{ id: `call-${(callId += 1)}`, name: 'broken', arguments: '{}' }],
    }));
    const loop = new AgentLoop({
      model,
      registry,
      sessions,
      sessionId: 'A',
      toolFailureThreshold: 2,
      maxTurns: 8,
    });

    const aResult = await loop.run('A 跑一个必然失败的工具');
    assert.equal(aResult.stopReason, 'tool_failure');
    assert.equal(aResult.trace.filter((entry) => entry.kind === 'tool').length, 2, 'A 失败 2 次后熔断');

    // 如果计数没有按会话隔离，B 的第一次失败就会把 streak 累到 3 直接熔断
    const bResult = await loop.run('B 也跑同一个工具', { sessionId: 'B' });
    assert.equal(bResult.stopReason, 'tool_failure');
    assert.equal(
      bResult.trace.filter((entry) => entry.kind === 'tool').length,
      2,
      'B 有自己的计数，应该失败 2 次后才熔断',
    );

    assert.ok(aResult.trace.every((entry) => entry.sessionId === 'A'));
    assert.ok(bResult.trace.every((entry) => entry.sessionId === 'B'));
    assert.ok(
      aResult.trace.every((entry) => entry.toolName !== 'broken' || entry.ok === false),
      '失败 trace 也要带 sessionId 与 toolName',
    );
  });
});
