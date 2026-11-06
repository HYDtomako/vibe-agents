/**
 * agent loop 行为测试（node:test + node:assert，不依赖网络与真实 key）。
 *
 * 用脚本化的假模型驱动 loop，覆盖：
 *  1. 直接回复（一轮结束）
 *  2. 单次工具调用 / 连续两次工具调用 / 同轮多个工具
 *  3. 工具抛异常 -> 模型收到错误并继续
 *  4. maxTurns 终止
 *  5. 模型返回非法 JSON 参数（不崩、错误回灌）
 *  6. 模型调用失败：可重试错误耗尽 / 401 / 402 配额
 *  7. 工具重试、确定性失败不重试、熔断、失败回执交回模型
 *  8. 用量累计与预算停止
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { AgentLoop, QUOTA_ANSWER } from '../src/loop.js';
import { ModelError } from '../src/model.js';
import { defineTool, toolFail, toolOk } from '../src/tools/base.js';
import { createDefaultRegistry } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { Message, ModelClient, ModelResponse, ToolSpec } from '../src/types.js';
import { UsageTracker } from '../src/usage.js';

interface ModelCall {
  messages: Message[];
  tools: ToolSpec[] | undefined;
}

type StepContext = { messages: Message[]; tools: ToolSpec[] | undefined };
type Step = ModelResponse | ((context: StepContext) => ModelResponse | Promise<ModelResponse>);

/** 脚本化假模型：按顺序返回预设响应，最后一步会重复使用 */
class ScriptedModel implements ModelClient {
  readonly calls: ModelCall[] = [];
  private index = 0;

  constructor(private readonly steps: Step[]) {
    if (steps.length === 0) throw new Error('ScriptedModel 至少需要一步');
  }

  async chat(messages: Message[], tools?: ToolSpec[]): Promise<ModelResponse> {
    this.calls.push({ messages: messages.map((message) => ({ ...message })), tools });
    const step = this.steps[Math.min(this.index, this.steps.length - 1)]!;
    this.index += 1;
    return typeof step === 'function' ? await step({ messages, tools }) : step;
  }

  get callCount(): number {
    return this.calls.length;
  }
}

/** 构造一个「发起一次工具调用」的响应 */
function toolCallStep(name: string, args: string, id = `call_${name}`): ModelResponse {
  return { content: '', toolCalls: [{ id, name, arguments: args }], usage: { totalTokens: 10 } };
}

/** 构造一个「直接回复」的响应 */
function finalStep(content: string): ModelResponse {
  return { content, toolCalls: [], usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 } };
}

function lastMessage(messages: Message[]): Message {
  const message = messages[messages.length - 1];
  if (!message) throw new Error('消息序列为空');
  return message;
}

/** 解析回灌给模型的 tool 消息内容 */
function parseToolPayload(message: Message): { ok: boolean; output: string; error?: string } {
  assert.equal(message.role, 'tool');
  return JSON.parse(message.content) as { ok: boolean; output: string; error?: string };
}

describe('AgentLoop', () => {
  it('场景 1：纯对话一轮直接返回，不再发起工具调用', async () => {
    const model = new ScriptedModel([finalStep('你好，我是最小 agent，没有调用任何工具。')]);
    const loop = new AgentLoop({ model, registry: createDefaultRegistry() });

    const result = await loop.run('你好');

    assert.equal(result.stopReason, 'final');
    assert.equal(result.turns, 1);
    assert.equal(result.answer, '你好，我是最小 agent，没有调用任何工具。');
    assert.equal(model.callCount, 1);

    // 模型确实收到了 system + user，并且拿到了工具声明
    const firstCall = model.calls[0]!;
    assert.equal(firstCall.messages[0]!.role, 'system');
    assert.equal(firstCall.messages[1]!.role, 'user');
    assert.equal(firstCall.messages[1]!.content, '你好');
    assert.deepEqual(
      firstCall.tools?.map((tool) => tool.name).sort(),
      ['calculator', 'edit_file', 'grep', 'read_file', 'remember', 'search', 'todo', 'weather', 'write_file'],
    );

    // trace：一轮 model + final + 用量汇总（kind=final），usage 透传
    assert.deepEqual(
      result.trace.map((entry) => entry.kind),
      ['model', 'final', 'final'],
    );
    assert.equal(result.trace[0]!.turn, 1);
    assert.equal(result.trace[0]!.usage?.totalTokens, 12);
    assert.match(result.trace.at(-1)!.note ?? '', /用量汇总：total=12/);
    assert.ok(result.trace.every((entry) => typeof entry.durationMs === 'number'));
  });

  it('场景 2：单次工具调用，结果回灌后模型给出最终答案', async () => {
    const model = new ScriptedModel([
      toolCallStep('calculator', JSON.stringify({ expression: '(1 + 2) * 3' }), 'call_calc'),
      finalStep('计算结果是 9。'),
    ]);
    const loop = new AgentLoop({ model, registry: createDefaultRegistry() });

    const result = await loop.run('帮我算一下 (1+2)*3');

    assert.equal(result.stopReason, 'final');
    assert.equal(result.turns, 2);
    assert.equal(model.callCount, 2);
    assert.equal(result.answer, '计算结果是 9。');

    // 第二次请求里带上了 role=tool 的回灌消息
    const secondCall = model.calls[1]!;
    const toolMessage = secondCall.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage, '第二次请求应包含 tool 消息');
    assert.equal(toolMessage.toolCallId, 'call_calc');
    assert.equal(toolMessage.name, 'calculator');

    const payload = parseToolPayload(toolMessage);
    assert.equal(payload.ok, true);
    assert.match(payload.output, /9/);

    // trace 里有工具条目：轮次、工具名、参数、结果摘要、耗时
    const toolEntry = result.trace.find((entry) => entry.kind === 'tool');
    assert.ok(toolEntry);
    assert.equal(toolEntry.turn, 1);
    assert.equal(toolEntry.toolName, 'calculator');
    assert.equal(toolEntry.args, '{"expression":"(1 + 2) * 3"}');
    assert.equal(toolEntry.ok, true);
    assert.match(toolEntry.resultSummary ?? '', /9/);
    assert.ok(toolEntry.durationMs >= 0);
  });

  it('场景 3：连续两次工具调用（跨两轮）后返回最终答案', async () => {
    const model = new ScriptedModel([
      toolCallStep('calculator', JSON.stringify({ expression: '2 * 21' }), 'call_1'),
      toolCallStep('todo', JSON.stringify({ action: 'add', text: '结果是 42' }), 'call_2'),
      finalStep('算完了，并把结果记进了待办。'),
    ]);
    const loop = new AgentLoop({ model, registry: createDefaultRegistry() });

    const result = await loop.run('先算 2*21，再把结果记到待办');

    assert.equal(result.stopReason, 'final');
    assert.equal(result.turns, 3);
    assert.equal(model.callCount, 3);
    assert.equal(result.answer, '算完了，并把结果记进了待办。');

    const toolEntries = result.trace.filter((entry) => entry.kind === 'tool');
    assert.equal(toolEntries.length, 2);
    assert.deepEqual(
      toolEntries.map((entry) => entry.toolName),
      ['calculator', 'todo'],
    );
    assert.ok(toolEntries.every((entry) => entry.ok === true));

    // 第三次请求应包含两条 tool 结果
    const toolMessages = model.calls[2]!.messages.filter((message) => message.role === 'tool');
    assert.equal(toolMessages.length, 2);
    assert.match(parseToolPayload(toolMessages[1]!).output, /已添加 #1/);
  });

  it('场景 4：工具抛异常后模型收到错误信息并继续，最终仍能正常结束', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'boom',
        description: '总是抛异常的工具，用于测试错误回灌',
        parameters: { type: 'object', properties: {} },
        todo: ['总是抛异常，用于验证 loop 的错误回灌'],
        async run() {
          throw new Error('磁盘写满了');
        },
      }),
    );

    const model = new ScriptedModel([
      toolCallStep('boom', '{}', 'call_boom'),
      ({ messages }) => {
        const payload = parseToolPayload(lastMessage(messages));
        return finalStep(payload.ok ? '不该走到这里' : `工具报错了，我如实说明：${payload.output}`);
      },
    ]);
    const loop = new AgentLoop({ model, registry });

    const result = await loop.run('试一下会失败的工具');

    // loop 没有崩：正常结束，并且模型看到了 ok=false
    assert.equal(result.stopReason, 'final');
    assert.equal(result.turns, 2);
    assert.match(result.answer, /磁盘写满了/);

    const toolEntry = result.trace.find((entry) => entry.kind === 'tool');
    assert.ok(toolEntry);
    assert.equal(toolEntry.ok, false);
    assert.match(toolEntry.resultSummary ?? '', /磁盘写满了/);
  });

  it('场景 5：达到 maxTurns 上限时明确终止，并给出终止原因', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'spin',
        description: '永远让模型继续调用的工具',
        parameters: { type: 'object', properties: {} },
        todo: ['永远返回固定字符串，让 loop 一直循环到 maxTurns'],
        async run() {
          return toolOk('still working');
        },
      }),
    );

    // 模型每轮都调用工具，永远不会自己停
    const model = new ScriptedModel([toolCallStep('spin', '{}', 'call_spin')]);
    const loop = new AgentLoop({ model, registry, maxTurns: 3 });

    const result = await loop.run('一直循环下去');

    assert.equal(result.stopReason, 'max_turns');
    assert.equal(result.turns, 3);
    assert.equal(model.callCount, 3);
    assert.match(result.answer, /最大轮次上限/);
    assert.match(result.answer, /maxTurns=3/);

    const finalEntry = result.trace.find((entry) => entry.note === 'max_turns');
    assert.ok(finalEntry);
    assert.equal(finalEntry.kind, 'final');
    assert.equal(result.trace.at(-1)!.kind, 'final');
    assert.match(result.trace.at(-1)!.note ?? '', /用量汇总/);
  });

  it('场景 6：模型给出非法 JSON 参数时不崩，错误回灌后继续', async () => {
    const model = new ScriptedModel([
      toolCallStep('calculator', '{"expression": "(1+2"', 'call_bad_json'),
      finalStep('参数有误，我改为直接回答：3。'),
    ]);
    const loop = new AgentLoop({ model, registry: createDefaultRegistry() });

    const result = await loop.run('算个非法表达式');

    assert.equal(result.stopReason, 'final');
    assert.equal(result.turns, 2);

    const toolEntry = result.trace.find((entry) => entry.kind === 'tool');
    assert.ok(toolEntry);
    assert.equal(toolEntry.ok, false);

    const toolMessage = model.calls[1]!.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage);
    const payload = parseToolPayload(toolMessage);
    assert.equal(payload.ok, false);
    assert.match(payload.error ?? '', /JSON/);
  });

  it('同一轮返回多个 tool_calls 时逐个执行并全部回灌', async () => {
    const model = new ScriptedModel([
      {
        content: '',
        toolCalls: [
          { id: 'c1', name: 'calculator', arguments: '{"expression":"2+2"}' },
          { id: 'c2', name: 'search', arguments: '{"query":"trace"}' },
        ],
        usage: { totalTokens: 5 },
      },
      finalStep('两件事都做完了。'),
    ]);
    const loop = new AgentLoop({ model, registry: createDefaultRegistry() });

    const result = await loop.run('同时算一下并查一下 trace 资料');

    assert.equal(result.stopReason, 'final');
    assert.equal(result.turns, 2);

    const toolEntries = result.trace.filter((entry) => entry.kind === 'tool');
    assert.deepEqual(
      toolEntries.map((entry) => entry.toolName),
      ['calculator', 'search'],
    );

    const toolMessages = model.calls[1]!.messages.filter((message) => message.role === 'tool');
    assert.equal(toolMessages.length, 2);
    assert.deepEqual(
      toolMessages.map((message) => message.toolCallId),
      ['c1', 'c2'],
    );
  });

  it('场景 7：模型调用失败时重试耗尽，返回 retry_exhausted 且不抛异常', async () => {
    const failingModel: ModelClient = {
      async chat() {
        throw new Error('HTTP 500');
      },
    };
    let calls = 0;
    const countedModel: ModelClient = {
      async chat(messages, tools) {
        calls += 1;
        return failingModel.chat(messages, tools);
      },
    };
    const loop = new AgentLoop({
      model: countedModel,
      registry: createDefaultRegistry(),
      retry: { sleep: async () => {} },
    });

    const result = await loop.run('随便聊聊');

    assert.equal(result.stopReason, 'retry_exhausted');
    assert.equal(result.turns, 1);
    assert.equal(calls, 3);
    assert.match(result.answer, /模型调用失败|调用模型失败/);
    assert.match(result.answer, /已重试 3 次/);
    assert.match(result.answer, /HTTP 500/);
    assert.match(result.answer, /LLM_BASE_URL/);
    assert.doesNotMatch(result.answer, /\n\s+at /);
    assert.ok(result.trace.some((entry) => entry.kind === 'model' && entry.ok === false));
    assert.equal(result.stats?.modelRetries, 2);
  });

  it('trace logger 可注入，且 logger 抛错不影响主流程', async () => {
    const seen: string[] = [];
    const model = new ScriptedModel([finalStep('完成')]);
    const loop = new AgentLoop({
      model,
      registry: new ToolRegistry(),
      logger: (entry) => {
        seen.push(entry.kind);
        throw new Error('logger 自己炸了');
      },
    });

    const result = await loop.run('你好');

    assert.equal(result.stopReason, 'final');
    assert.deepEqual(seen, ['model', 'final', 'final']);
    assert.equal(result.trace.length, 3);
  });

  it('history 可注入，用于续聊（为多 session 预留的接口）', async () => {
    const model = new ScriptedModel([finalStep('记得，我们说好的是 42。')]);
    const loop = new AgentLoop({ model, registry: new ToolRegistry() });
    const history: Message[] = [
      { role: 'user', content: '记住这个数字：42' },
      { role: 'assistant', content: '好的，记住了。' },
    ];

    const result = await loop.run('我刚才让你记住什么？', { history });

    const messages = model.calls[0]!.messages;
    assert.equal(messages.length, 4);
    assert.equal(messages[1]!.content, '记住这个数字：42');
    assert.equal(lastMessage(result.messages).role, 'assistant');
  });
});

describe('AgentLoop：异常处理与额度', () => {
  it('工具网络错自动重试后成功，trace 记录 attempt 与分类', async () => {
    const registry = new ToolRegistry();
    let runs = 0;
    registry.register(
      defineTool({
        name: 'flaky',
        description: '前两次网络失败，第三次成功',
        parameters: { type: 'object', properties: {} },
        todo: ['按调用次数模拟网络抖动，用于验证 loop 的工具重试'],
        async run() {
          runs += 1;
          if (runs <= 2) return toolFail('上游超时', 'ETIMEDOUT', true);
          return toolOk('第三次成功');
        },
      }),
    );

    const model = new ScriptedModel([
      toolCallStep('flaky', '{}', 'call_flaky'),
      finalStep('成功拿到结果'),
    ]);
    const waits: number[] = [];
    const loop = new AgentLoop({
      model,
      registry,
      retry: {
        sleep: async (ms) => {
          waits.push(ms);
        },
        jitter: false,
        baseDelayMs: 10,
        maxDelayMs: 100,
      },
    });

    const result = await loop.run('试试网络工具');

    assert.equal(result.stopReason, 'final');
    assert.equal(runs, 3);
    assert.deepEqual(waits, [10, 20]);

    const toolEntries = result.trace.filter((entry) => entry.kind === 'tool');
    assert.equal(toolEntries.length, 3);
    assert.equal(toolEntries[0]!.ok, false);
    assert.match(toolEntries[0]!.note ?? '', /attempt 1\/3/);
    assert.match(toolEntries[0]!.note ?? '', /分类=retryable/);
    assert.match(toolEntries[0]!.note ?? '', /等待 10ms 后重试/);
    assert.match(toolEntries[1]!.note ?? '', /等待 20ms 后重试/);
    assert.equal(toolEntries[2]!.ok, true);
    assert.match(toolEntries[2]!.note ?? '', /第 3 次尝试成功/);

    assert.equal(result.stats?.toolCalls, 1);
    assert.equal(result.stats?.toolRetries, 2);
    assert.equal(result.stats?.toolFailures, 0);
    // 用量：toolCallStep 10 + finalStep 12
    assert.equal(result.stats?.usage.totalTokens, 22);
    assert.match(result.trace.at(-1)!.note ?? '', /重试 2 次/);
  });

  it('参数错（确定性失败）不重试，只执行 1 次', async () => {
    const registry = new ToolRegistry();
    let runs = 0;
    registry.register(
      defineTool({
        name: 'bad-args',
        description: '永远返回参数非法',
        parameters: { type: 'object', properties: {} },
        todo: ['返回确定性参数错误，用于验证 loop 不重试 fatal 失败'],
        async run() {
          runs += 1;
          return toolFail('参数不是合法 JSON', 'INVALID_ARGUMENTS_JSON');
        },
      }),
    );

    const model = new ScriptedModel([
      toolCallStep('bad-args', '{}', 'call_bad'),
      finalStep('参数有误，我直接说明。'),
    ]);
    const waits: number[] = [];
    const loop = new AgentLoop({
      model,
      registry,
      retry: { sleep: async (ms) => void waits.push(ms), jitter: false },
    });

    const result = await loop.run('试一下参数错误');

    assert.equal(result.stopReason, 'final');
    assert.equal(runs, 1);
    assert.deepEqual(waits, []);
    const toolEntries = result.trace.filter((entry) => entry.kind === 'tool');
    assert.equal(toolEntries.length, 1);
    assert.equal(toolEntries[0]!.ok, false);
    assert.match(toolEntries[0]!.note ?? '', /分类=fatal/);
    assert.equal(result.stats?.toolRetries, 0);

    const payload = parseToolPayload(lastMessage(model.calls[1]!.messages));
    assert.equal(payload.ok, false);
    assert.equal(payload.error, 'INVALID_ARGUMENTS_JSON');
  });

  it('同一工具连续失败 3 次触发熔断，stopReason=tool_failure', async () => {
    const registry = new ToolRegistry();
    let runs = 0;
    registry.register(
      defineTool({
        name: 'always-bad',
        description: '永远确定性失败',
        parameters: { type: 'object', properties: {} },
        todo: ['永远返回确定性失败，用于验证连续失败熔断'],
        async run() {
          runs += 1;
          return toolFail('参数非法：缺少 expression', 'INVALID_ARGUMENTS_JSON');
        },
      }),
    );

    // 模型每轮都调用同一个坏工具，永远不停
    const model = new ScriptedModel([toolCallStep('always-bad', '{}', 'call_bad')]);
    const loop = new AgentLoop({
      model,
      registry,
      maxTurns: 8,
      retry: { sleep: async () => {}, jitter: false },
    });

    const result = await loop.run('一直调用坏工具');

    assert.equal(result.stopReason, 'tool_failure');
    assert.equal(result.turns, 3);
    assert.equal(runs, 3);
    assert.equal(model.callCount, 3);
    assert.match(result.answer, /熔断/);
    assert.match(result.answer, /工具：always-bad/);
    assert.match(result.answer, /未重试（确定性失败）|已重试/);
    assert.doesNotMatch(result.answer, /\n\s+at /);
    assert.equal(result.stats?.toolFailures, 3);
    assert.ok(result.trace.some((entry) => entry.kind === 'final' && entry.note === 'tool_failure'));
  });

  it('重试耗尽的失败回执交回模型，模型换策略后成功', async () => {
    const registry = createDefaultRegistry();
    let runs = 0;
    registry.register(
      defineTool({
        name: 'net',
        description: '永远网络超时',
        parameters: { type: 'object', properties: {} },
        todo: ['永远返回可重试的网络失败，用于验证失败回执与换策略'],
        async run() {
          runs += 1;
          return toolFail('请求超时', 'ETIMEDOUT', true);
        },
      }),
    );

    const model = new ScriptedModel([
      toolCallStep('net', '{}', 'call_net'),
      ({ messages }) => {
        const payload = parseToolPayload(lastMessage(messages));
        assert.equal(payload.ok, false);
        assert.equal(payload.error, 'TOOL_RETRY_EXHAUSTED');
        assert.match(payload.output, /工具 net/);
        assert.match(payload.output, /分类：retryable/);
        assert.match(payload.output, /已重试 2 次仍失败/);
        assert.match(payload.output, /建议/);
        // 模型看到回执后换用计算器
        return toolCallStep('calculator', JSON.stringify({ expression: '1+1' }), 'call_calc');
      },
      finalStep('网络工具不可用，我改用计算器：答案是 2。'),
    ]);

    const loop = new AgentLoop({
      model,
      registry,
      retry: { sleep: async () => {}, jitter: false, baseDelayMs: 1 },
    });

    const result = await loop.run('查不到就用计算器');

    assert.equal(result.stopReason, 'final');
    assert.equal(result.turns, 3);
    assert.equal(runs, 3);
    assert.equal(model.callCount, 3);
    assert.match(result.answer, /答案是 2/);

    const toolEntries = result.trace.filter((entry) => entry.kind === 'tool');
    assert.equal(toolEntries.filter((entry) => entry.ok === false).length, 3);
    assert.ok(toolEntries.some((entry) => entry.toolName === 'calculator' && entry.ok === true));
    assert.equal(result.stats?.toolFailures, 1);
    assert.equal(result.stats?.toolRetries, 2);
  });

  it('模型 429 带 Retry-After：按服务端建议等待后成功', async () => {
    let calls = 0;
    const model: ModelClient = {
      async chat() {
        calls += 1;
        if (calls === 1) {
          throw new ModelError('模型调用失败：HTTP 429', 429, 'rate limit', 25);
        }
        return finalStep('限流恢复后回答');
      },
    };
    const waits: number[] = [];
    const loop = new AgentLoop({
      model,
      registry: new ToolRegistry(),
      retry: {
        sleep: async (ms) => {
          waits.push(ms);
        },
        jitter: false,
        baseDelayMs: 300,
      },
    });

    const result = await loop.run('聊聊');

    assert.equal(result.stopReason, 'final');
    assert.equal(calls, 2);
    assert.deepEqual(waits, [25]);
    assert.equal(result.stats?.modelRetries, 1);
    assert.match(result.answer, /限流恢复后回答/);
    const failed = result.trace.find((entry) => entry.kind === 'model' && entry.ok === false);
    assert.ok(failed);
    assert.match(failed.note ?? '', /attempt 1\/3/);
    assert.match(failed.note ?? '', /分类=retryable/);
    assert.match(failed.note ?? '', /Retry-After=25ms/);
  });

  it('模型 401：直接停止，不重试，不输出堆栈', async () => {
    let calls = 0;
    const model: ModelClient = {
      async chat() {
        calls += 1;
        throw new ModelError('模型调用失败：HTTP 401', 401, 'invalid api key');
      },
    };
    const waits: number[] = [];
    const loop = new AgentLoop({
      model,
      registry: new ToolRegistry(),
      retry: { sleep: async (ms) => void waits.push(ms), jitter: false },
    });

    const result = await loop.run('聊聊');

    assert.equal(result.stopReason, 'model_error');
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
    assert.match(result.answer, /HTTP 401/);
    assert.match(result.answer, /LLM_API_KEY/);
    assert.doesNotMatch(result.answer, /\n\s+at /);
    assert.equal(result.stats?.modelRetries, 0);
    assert.ok(result.trace.some((entry) => entry.kind === 'final' && entry.note === 'model_error'));
  });

  it('模型 402 / insufficient_quota：停止并给出额度不足中文提示', async () => {
    let calls = 0;
    const model: ModelClient = {
      async chat() {
        calls += 1;
        throw new ModelError('模型调用失败：HTTP 402', 402, 'insufficient_quota');
      },
    };
    const loop = new AgentLoop({
      model,
      registry: new ToolRegistry(),
      retry: { sleep: async () => {}, jitter: false },
    });

    const result = await loop.run('聊聊');

    assert.equal(result.stopReason, 'quota_exhausted');
    assert.equal(calls, 1);
    assert.equal(result.answer, QUOTA_ANSWER);
    assert.match(result.answer, /额度不足/);
    assert.match(result.answer, /未重试/);
    assert.doesNotMatch(result.answer, /\n\s+at /);
    assert.doesNotMatch(result.answer, /D:\\mini-agent/);
    assert.equal(result.stats?.usage.failures, 1);
  });

  it('累计用量达到预算上限后，下一次调模型前停止', async () => {    const usage = new UsageTracker({ budgetTokens: 10 });
    const model = new ScriptedModel([
      // 这一轮 usage.totalTokens=10，刚好达到预算
      toolCallStep('calculator', JSON.stringify({ expression: '1+1' }), 'call_calc'),
      finalStep('不该被调用'),
    ]);
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      usage,
      retry: { sleep: async () => {}, jitter: false },
    });

    const result = await loop.run('算一下');

    assert.equal(result.stopReason, 'quota_exhausted');
    // 第 2 轮进入循环、在调模型前被预算检查拦下
    assert.equal(result.turns, 2);
    assert.equal(model.callCount, 1);
    assert.match(result.answer, /累计用量 10 tokens/);
    assert.match(result.answer, /预算上限 10/);
    assert.match(result.answer, /AGENT_BUDGET_TOKENS/);
    assert.equal(result.stats?.usage.totalTokens, 10);
    assert.equal(result.stats?.usage.overBudget, true);
    assert.ok(result.trace.some((entry) => entry.kind === 'final' && entry.note === 'quota_exhausted: budget'));
  });

  it('loop 结束时把用量落盘到 UsageTracker.filePath', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mini-agent-loop-usage-'));
    try {
      const filePath = path.join(dir, '.agent-usage.json');
      const usage = new UsageTracker({ filePath });
      const model = new ScriptedModel([finalStep('完成')]);
      const loop = new AgentLoop({ model, registry: new ToolRegistry(), usage });

      const result = await loop.run('你好');

      assert.equal(result.stopReason, 'final');
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
        version: number;
        totalTokens: number;
        promptTokens: number;
        completionTokens: number;
        calls: number;
      };
      assert.equal(parsed.version, 1);
      assert.equal(parsed.totalTokens, 12);
      assert.equal(parsed.promptTokens, 5);
      assert.equal(parsed.completionTokens, 7);
      assert.equal(parsed.calls, 1);
      assert.equal(usage.persistError, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
