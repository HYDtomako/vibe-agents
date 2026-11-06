/**
 * 工具统一写法（defineTool）与 registry 兜底行为测试。
 *
 * 覆盖：
 * - defineTool 的校验：name/description 非空、parameters 必须是 object schema、
 *   todo 非空且不许出现 TODO / TBD / 空串；
 * - registry 的失败兜底：未知工具、非法 JSON、重复注册。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineTool, toolFail, toolOk } from '../src/tools/base.js';
import type { Tool } from '../src/tools/base.js';
import { ToolRegistry } from '../src/tools/registry.js';

const baseParams = { type: 'object' as const, properties: {} };

function makeTool(patch: Partial<Tool> = {}): Tool {
  return {
    name: 'demo',
    description: '演示工具',
    parameters: baseParams,
    todo: ['演示 defineTool 的校验，不做实际工作'],
    async run() {
      return toolOk('ok');
    },
    ...patch,
  };
}

describe('defineTool：声明校验', () => {
  it('合法定义原样返回', () => {
    const tool = makeTool();
    assert.equal(defineTool(tool), tool);
  });

  it('name / description 为空时抛错', () => {
    assert.throws(() => defineTool(makeTool({ name: '  ' })), /name/);
    assert.throws(() => defineTool(makeTool({ description: '' })), /description/);
  });

  it('parameters 必须是 type:"object" 的 schema', () => {
    assert.throws(
      () => defineTool(makeTool({ parameters: { type: 'string' } })),
      /type:'object'/,
    );
  });

  it('todo 为空数组时抛错', () => {
    assert.throws(() => defineTool(makeTool({ todo: [] })), /todo/);
  });

  it('todo 里有空串时抛错', () => {
    assert.throws(() => defineTool(makeTool({ todo: ['做什么', '   '] })), /非空字符串/);
  });

  it('todo 里出现 TODO / TBD 占位符时抛错', () => {
    assert.throws(() => defineTool(makeTool({ todo: ['第一步', 'TODO: 补充失败情况'] })), /TODO/);
    assert.throws(() => defineTool(makeTool({ todo: ['TBD 边界'] })), /TODO|TBD/);
  });

  it('缺 run 实现时抛错', () => {
    const tool = makeTool();
    delete (tool as Partial<Tool>).run;
    assert.throws(() => defineTool(tool), /run/);
  });
});

describe('toolOk / toolFail', () => {
  it('构造成功与失败结果', () => {
    assert.deepEqual(toolOk('done'), { ok: true, output: 'done' });
    assert.deepEqual(toolOk('done', { a: 1 }), { ok: true, output: 'done', data: { a: 1 } });
    assert.deepEqual(toolFail('坏了'), { ok: false, output: '坏了' });
    assert.deepEqual(toolFail('坏了', 'E_BAD'), { ok: false, output: '坏了', error: 'E_BAD' });
  });
});

describe('ToolRegistry：失败一律 ok=false', () => {
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: 'keeper',
      description: '永远成功',
      parameters: baseParams,
      todo: ['永远返回 ok，用于对照失败分支'],
      async run() {
        return toolOk('kept');
      },
    }),
  );

  it('未知工具折算 ok=false 并列出可用工具', async () => {
    const result = await registry.run('missing', '{}');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'UNKNOWN_TOOL');
    assert.match(result.output, /keeper/);
  });

  it('非法 JSON 参数折算 ok=false', async () => {
    const result = await registry.run('keeper', '{oops');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_ARGUMENTS_JSON');
  });

  it('重复注册同名工具抛错', () => {
    assert.throws(
      () =>
        registry.register(
          defineTool({
            name: 'keeper',
            description: '重复的名字',
            parameters: baseParams,
            todo: ['用于验证重复注册会被拒绝'],
            async run() {
              return toolOk('dup');
            },
          }),
        ),
      /已注册/,
    );
  });

  it('工具主动返回 ok=false 时原样透传', async () => {
    const registry2 = new ToolRegistry();
    registry2.register(
      defineTool({
        name: 'refuse',
        description: '主动失败',
        parameters: baseParams,
        todo: ['主动返回 ok=false，用于验证失败结果透传'],
        async run() {
          return toolFail('不允许', 'DENIED');
        },
      }),
    );
    const result = await registry2.run('refuse', '{}');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'DENIED');
    assert.equal(result.output, '不允许');
  });
});
