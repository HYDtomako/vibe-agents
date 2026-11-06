/**
 * 工具注册表与内置工具测试：注册、导出、统一异常兜底、todo 状态、search mock 命中。
 *
 * 阶段 1 起工具统一用 defineTool 定义，register(tool) 只接受 Tool。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineTool, toolOk } from '../src/tools/base.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createDefaultRegistry, createTodoTool, searchDocs } from '../src/tools/index.js';

const echoTool = defineTool({
  name: 'echo',
  description: '原样返回 text',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  todo: ['把输入原样回显，用于测试工具协议', '第一步：读取 text', '失败情况：不做校验，永远成功'],
  async run(args) {
    return toolOk(`echo:${String(args['text'] ?? '')}`);
  },
});

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  return registry;
}

describe('ToolRegistry：注册与导出', () => {
  it('list() 导出模型可直接使用的 spec', () => {
    const registry = makeRegistry();
    const tools = registry.list();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, 'echo');
    assert.equal(tools[0]!.description, '原样返回 text');
    assert.equal(tools[0]!.parameters.type, 'object');
    assert.equal(registry.has('echo'), true);
    assert.equal(registry.size, 1);
  });

  it('list() 只导出 name / description / parameters，不带 todo 与 run', () => {
    const tools = makeRegistry().list();
    assert.deepEqual(Object.keys(tools[0]!).sort(), ['description', 'name', 'parameters']);
  });

  it('list() 返回副本，外部改动不影响注册表', () => {
    const registry = makeRegistry();
    const tools = registry.list();
    tools[0]!.name = '被改掉了';
    tools.length = 0;
    assert.equal(registry.list()[0]!.name, 'echo');
  });

  it('重复注册、缺少声明、缺 todo 都会尽早报错', () => {
    const registry = makeRegistry();
    assert.throws(() => registry.register(echoTool), /已注册/);
    assert.throws(
      () =>
        registry.register(
          defineTool({
            name: '',
            description: 'x',
            parameters: { type: 'object' },
            todo: ['x'],
            async run() {
              return toolOk('x');
            },
          }),
        ),
      /name/,
    );
    assert.throws(
      () =>
        registry.register(
          defineTool({
            name: 'no-desc',
            description: ' ',
            parameters: { type: 'object' },
            todo: ['x'],
            async run() {
              return toolOk('x');
            },
          }),
        ),
      /description/,
    );
    assert.throws(
      () =>
        registry.register({
          name: 'no-todo',
          description: '缺 todo',
          parameters: { type: 'object' },
          todo: [],
          async run() {
            return toolOk('x');
          },
        }),
      /todo/,
    );
  });
});

describe('ToolRegistry：执行与异常兜底', () => {
  it('成功执行并返回字符串结果', async () => {
    const result = await makeRegistry().run('echo', JSON.stringify({ text: 'hi' }));
    assert.equal(result.ok, true);
    assert.equal(result.output, 'echo:hi');
    assert.ok(typeof result.durationMs === 'number');
  });

  it('对象结果会被序列化成文本', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'obj',
        description: '返回对象',
        parameters: { type: 'object', properties: {} },
        todo: ['返回一个固定对象，用于验证对象结果的序列化'],
        async run() {
          return toolOk(JSON.stringify({ a: 1, b: '二' }));
        },
      }),
    );
    const result = await registry.run('obj', '{}');
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.output), { a: 1, b: '二' });
  });

  it('未知工具不抛异常，返回 ok=false', async () => {
    const result = await makeRegistry().run('nope', '{}');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'UNKNOWN_TOOL');
    assert.match(result.output, /未知工具：nope/);
  });

  it('非法 JSON 参数不抛异常，返回 ok=false', async () => {
    const result = await makeRegistry().run('echo', '{"text": "hi"');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_ARGUMENTS_JSON');
    assert.match(result.output, /不是合法 JSON/);
  });

  it('参数不是 JSON 对象时返回 ok=false', async () => {
    const result = await makeRegistry().run('echo', '[1,2,3]');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_ARGUMENTS_TYPE');
  });

  it('空参数按空对象处理', async () => {
    const result = await makeRegistry().run('echo', '');
    assert.equal(result.ok, true);
    assert.equal(result.output, 'echo:');
  });

  it('run 抛异常被捕获，不向外抛', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'boom',
        description: '总是失败',
        parameters: { type: 'object', properties: {} },
        todo: ['总是抛异常，用于验证 registry 的兜底'],
        async run() {
          throw new Error('磁盘写满了');
        },
      }),
    );

    const result = await registry.run('boom', '{}');
    assert.equal(result.ok, false);
    assert.equal(result.error, '磁盘写满了');
    assert.match(result.output, /工具 boom 执行失败：磁盘写满了/);
  });

  it('异步 run reject 同样被捕获', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'async-boom',
        description: '异步失败',
        parameters: { type: 'object', properties: {} },
        todo: ['异步 reject，用于验证 registry 的兜底'],
        async run() {
          return Promise.reject(new Error('超时'));
        },
      }),
    );
    const result = await registry.run('async-boom', '{}');
    assert.equal(result.ok, false);
    assert.match(result.output, /超时/);
  });

  it('工具能拿到上下文（为 session 隔离预留）', async () => {
    const registry = new ToolRegistry();
    let seenSession: string | undefined;
    registry.register(
      defineTool({
        name: 'ctx',
        description: '读取上下文',
        parameters: { type: 'object', properties: {} },
        todo: ['读取 ToolContext 并回显工具名，用于验证上下文透传'],
        async run(_args, context) {
          seenSession = context.sessionId;
          return toolOk(context.toolName);
        },
      }),
    );

    const result = await registry.run('ctx', '{}', { sessionId: 's-1' });
    assert.equal(result.ok, true);
    assert.equal(result.output, 'ctx');
    assert.equal(seenSession, 's-1');
  });
});

describe('默认工具集', () => {
  it('包含 9 个内置工具', () => {
    const names = createDefaultRegistry()
      .list()
      .map((tool) => tool.name)
      .sort();
    assert.deepEqual(names, ['calculator', 'edit_file', 'grep', 'read_file', 'remember', 'search', 'todo', 'weather', 'write_file']);
  });

  it('calculator 通过注册表可执行', async () => {
    const result = await createDefaultRegistry().run('calculator', JSON.stringify({ expression: '6/4' }));
    assert.equal(result.ok, true);
    assert.match(result.output, /1\.5/);
  });

  it('todo 支持 add -> list -> done 全流程', async () => {
    const registry = createDefaultRegistry();

    const added = await registry.run('todo', JSON.stringify({ action: 'add', text: '写 README' }));
    assert.equal(added.ok, true);
    assert.match(added.output, /已添加 #1/);

    await registry.run('todo', JSON.stringify({ action: 'add', text: '跑测试' }));

    const listed = await registry.run('todo', JSON.stringify({ action: 'list' }));
    assert.equal(listed.ok, true);
    const payload = JSON.parse(listed.output) as { count: number; items: Array<{ done: boolean }> };
    assert.equal(payload.count, 2);
    assert.equal(payload.items[0]!.done, false);

    const done = await registry.run('todo', JSON.stringify({ action: 'done', id: 1 }));
    assert.equal(done.ok, true);
    assert.match(done.output, /已标记 #1 完成/);

    const afterDone = JSON.parse((await registry.run('todo', JSON.stringify({ action: 'list' }))).output) as {
      items: Array<{ done: boolean }>;
    };
    assert.equal(afterDone.items[0]!.done, true);
  });

  it('todo 非法 action / 不存在的 id 返回 ok=false', async () => {
    const registry = createDefaultRegistry();
    const badAction = await registry.run('todo', JSON.stringify({ action: 'delete' }));
    assert.equal(badAction.ok, false);
    assert.match(badAction.output, /未知 action/);

    const missing = await registry.run('todo', JSON.stringify({ action: 'done', id: 99 }));
    assert.equal(missing.ok, false);
    assert.match(missing.output, /找不到编号/);
  });

  it('todo 状态按实例隔离', async () => {
    const a = createTodoTool();
    const b = createTodoTool();
    await a.tool.run({ action: 'add', text: '只属于 a' }, { toolName: 'todo' });
    assert.equal(a.snapshot().length, 1);
    assert.equal(b.snapshot().length, 0);
  });

  it('search 用固定假数据返回命中结果', async () => {
    const result = await createDefaultRegistry().run('search', JSON.stringify({ query: 'trace' }));
    assert.equal(result.ok, true);
    const payload = JSON.parse(result.output) as { total: number; results: Array<{ id: string }> };
    assert.ok(payload.total > 0);
    assert.ok(payload.results.some((hit) => hit.id === 'doc-3'));
  });

  it('search 无命中时返回空列表而不是报错', async () => {
    const hits = searchDocs('不存在的关键词xyz');
    assert.deepEqual(hits, []);
    const result = await createDefaultRegistry().run('search', JSON.stringify({ query: 'xyzxyz' }));
    assert.equal(result.ok, true);
    assert.match(result.output, /没有匹配结果/);
  });

  it('search 缺少 query 时返回 ok=false', async () => {
    const result = await createDefaultRegistry().run('search', '{}');
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.match(result.output, /query/);
  });
});
