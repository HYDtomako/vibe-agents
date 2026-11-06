/**
 * trace 落盘测试（node:test + node:assert，不联网、不用真实 key）。
 *
 * 覆盖：
 *  1. 事件公共字段：seq 从 1 递增、ts 是 ISO 时间、run.start 的 turn=0、
 *     run.end 的 turn 等于最终轮次（与 turns 同值）、run.start/run.end 成对；
 *  2. MarkdownSink 追加写 + 每条 flush：不 close 也能读到，后续写入失败不影响已写内容；
 *  3. fs.write：前后 sha256 正确、快照文件真实存在且内容就是原文件；
 *  4. context.compact 与 memory.inject 在真实 loop 流程里各发一条；
 *  5. trace 不影响消息内容（配不配 sink，messages 完全一致）。
 *
 * 全部在 os.tmpdir() 下跑，不写项目目录。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ContextEngine } from '../src/context.js';
import { AgentLoop } from '../src/loop.js';
import { MemoryStore } from '../src/memory.js';
import { sha256Hex } from '../src/tools/base.js';
import { createDefaultRegistry } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { MarkdownSink, stampEvent } from '../src/trace.js';
import type { TraceEvent, TraceSink } from '../src/trace.js';
import type { Message, ModelClient, ModelResponse, ToolSpec } from '../src/types.js';

let baseDir = '';

type Step = ModelResponse | ((messages: Message[]) => ModelResponse);

/** 脚本化假模型：按顺序返回预设响应，最后一步会重复使用 */
class ScriptedModel implements ModelClient {
  readonly calls: Message[][] = [];
  private index = 0;

  constructor(
    private readonly steps: Step[],
    private readonly name = 'fake-model',
  ) {}

  async chat(messages: Message[], _tools?: ToolSpec[]): Promise<ModelResponse> {
    this.calls.push(messages.map((message) => ({ ...message })));
    const step = this.steps[Math.min(this.index, this.steps.length - 1)]!;
    this.index += 1;
    return typeof step === 'function' ? step(messages) : step;
  }
}

/** 只收集事件，不落盘；用来断言事件内容 */
class RecordingSink implements TraceSink {
  readonly events: TraceEvent[] = [];

  emit(event: TraceEvent): void {
    this.events.push(event);
  }
}

function toolCallStep(name: string, args: string, id = `call_${name}`): ModelResponse {
  return { content: '', toolCalls: [{ id, name, arguments: args }], usage: { totalTokens: 10 } };
}

function finalStep(content: string): ModelResponse {
  return { content, toolCalls: [], usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 } };
}

/** 假摘要器：返回一句比中段短的摘要 */
class FakeSummarizer implements ModelClient {
  readonly prompts: string[] = [];

  async chat(messages: Message[]): Promise<ModelResponse> {
    this.prompts.push(messages.map((message) => message.content).join('\n'));
    return { content: '早前对话的摘要：用户逐轮提问，agent 逐轮回答。', toolCalls: [] };
  }
}

/** 把 trace.markdown 里的 json 代码块解析回来，只留事件对象 */
function parseEvents(markdown: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const match of markdown.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    const parsed: unknown = JSON.parse(match[1]!);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'type' in parsed) {
      events.push(parsed as TraceEvent);
    }
  }
  return events;
}

/** 去掉 createdAt 的时间戳差异，便于比较两次 run 的消息内容 */
function contentOf(messages: readonly Message[]): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.name ? { name: message.name } : {}),
  }));
}

before(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'mini-agent-trace-'));
});

after(async () => {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
});

describe('trace：事件公共字段与配对', () => {
  it('seq 从 1 递增、ts 是 ISO、非轮次事件 turn=0、run.start 与 run.end 成对', async () => {
    const sink = new RecordingSink();
    const model = new ScriptedModel([
      toolCallStep('calculator', JSON.stringify({ expression: '(1 + 2) * 3' }), 'call_calc'),
      finalStep('计算结果是 9。'),
    ]);
    const loop = new AgentLoop({
      model,
      modelName: 'fake-model',
      registry: createDefaultRegistry(),
      traceSink: sink,
    });

    const result = await loop.run('帮我算一下 (1+2)*3');
    assert.equal(result.stopReason, 'final');

    const events = sink.events;
    assert.ok(events.length >= 6, `事件太少：${events.length}`);
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_event, index) => index + 1),
      'seq 必须从 1 开始逐条 +1',
    );
    for (const event of events) {
      assert.equal(typeof event.ts, 'string');
      assert.equal(new Date(event.ts).toISOString(), event.ts, `ts 必须是 ISO 时间：${event.ts}`);
      assert.equal(typeof event.turn, 'number');
    }

    const start = events[0]!;
    assert.equal(start.type, 'run.start');
    assert.equal(start.turn, 0);
    assert.equal(events.at(-1)!.type, 'run.end');
    assert.equal(events.filter((event) => event.type === 'run.start').length, 1);
    assert.equal(events.filter((event) => event.type === 'run.end').length, 1);

    if (start.type !== 'run.start') throw new Error('首个事件必须是 run.start');
    assert.equal(start.input, '帮我算一下 (1+2)*3');
    assert.equal(start.model, 'fake-model');
    assert.equal(start.sandboxRoot, path.resolve(process.cwd()));
    assert.ok(start.systemPrompt.length > 0);

    const types = events.map((event) => event.type);
    assert.deepEqual(types, ['run.start', 'model.reply', 'tool.call', 'tool.result', 'model.reply', 'run.end']);

    const toolCall = events.find((event) => event.type === 'tool.call');
    assert.ok(toolCall && toolCall.type === 'tool.call');
    assert.equal(toolCall.toolName, 'calculator');
    assert.equal(toolCall.toolCallId, 'call_calc');
    assert.equal(toolCall.arguments, '{"expression":"(1 + 2) * 3"}');
    assert.equal(toolCall.turn, 1);

    const toolResult = events.find((event) => event.type === 'tool.result');
    assert.ok(toolResult && toolResult.type === 'tool.result');
    assert.equal(toolResult.ok, true);
    assert.equal(toolResult.attempts, 1);
    assert.match(toolResult.output, /9/);

    const replies = events.filter((event) => event.type === 'model.reply');
    assert.ok(replies.every((event) => event.type === 'model.reply' && event.compressed === false));
    assert.ok(replies.every((event) => event.type === 'model.reply' && event.memoryHits === 0));
    const second = replies[1]!;
    if (second.type !== 'model.reply') throw new Error('第二条回复事件缺失');
    assert.equal(second.content, '计算结果是 9。');
    assert.equal(second.turn, 2);
    assert.equal(second.usage?.totalTokens, 12);

    const end = events.at(-1)!;
    if (end.type !== 'run.end') throw new Error('末个事件必须是 run.end');
    assert.equal(end.stopReason, 'final');
    assert.equal(end.turns, 2);
    assert.equal(end.usage.totalTokens, 22);
    assert.match(end.usageSummary, /用量汇总：total=22/);
  });

  it('sink 抛错不影响对话：run 正常结束，答案与 trace 都在', async () => {
    const exploding: TraceSink = {
      emit() {
        throw new Error('sink 自己炸了');
      },
    };
    const model = new ScriptedModel([finalStep('照样回答')]);
    const loop = new AgentLoop({
      model,
      registry: new ToolRegistry(),
      traceSink: exploding,
    });

    const result = await loop.run('你好');

    assert.equal(result.stopReason, 'final');
    assert.equal(result.answer, '照样回答');
    assert.equal(result.trace.length, 3);
  });
});

describe('trace：MarkdownSink 追加写与 flush', () => {
  it('每条事件写一次并 flush：不 close 也能读到，后续写入失败不影响已写内容', async () => {
    const dir = path.join(baseDir, 'sink-append');
    const sink = new MarkdownSink({ dir, runId: 'run-1' });

    const first = stampEvent(
      { type: 'tool.call', toolName: 'calculator', arguments: '{"expression":"1+1"}', toolCallId: 'c1' },
      1,
      1,
    );
    await sink.emit(first);

    // 没有 close / finalize 也已经在盘上：这就是「每条 flush」的含义
    const afterFirst = await readFile(sink.filePath, 'utf8');
    assert.match(afterFirst, /^# Trace run-1/);
    assert.match(afterFirst, /## #1 tool\.call（turn 1）/);
    assert.match(afterFirst, /"toolName": "calculator"/);

    // 模拟后续事件写入抛错：循环引用让 JSON.stringify 抛 TypeError
    const circular: Record<string, unknown> = { type: 'tool.result', toolName: 'calculator', ok: true };
    circular['self'] = circular;
    await sink.emit(circular as unknown as TraceEvent);
    assert.ok(sink.error instanceof Error, '写失败要记在 sink.error 上，而不是抛给调用方');

    const afterFail = await readFile(sink.filePath, 'utf8');
    assert.equal(afterFail, afterFirst, '失败的那条不落地，已写内容一条都不能丢');

    // 失败之后还能继续追加，顺序不乱
    const usage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      calls: 1,
      failures: 0,
      retries: 0,
      missingUsageCalls: 1,
      overBudget: false,
    };
    await sink.emit(
      stampEvent(
        { type: 'run.end', stopReason: 'final', turns: 1, usage, usageSummary: '用量汇总：total=0' },
        2,
        1,
      ),
    );
    const afterSecond = await readFile(sink.filePath, 'utf8');
    assert.match(afterSecond, /## #2 run\.end（turn 1）/);
    assert.ok(afterSecond.startsWith(afterFirst), '追加写，不覆盖已有内容');
  });

  it('finalize 把完整 messages 追加到文件末尾', async () => {
    const dir = path.join(baseDir, 'sink-finalize');
    const sink = new MarkdownSink({ dir, runId: 'run-2' });
    await sink.emit(stampEvent({ type: 'run.start', input: '你好', model: 'm', sandboxRoot: '/tmp', systemPrompt: '系统提示' }, 1, 0));
    const messages: Message[] = [{ role: 'user', content: '你好' }];
    await sink.finalize(messages);

    const markdown = await readFile(sink.filePath, 'utf8');
    assert.match(markdown, /## 完整 messages（复现用，共 1 条）/);
    assert.match(markdown, /"content": "你好"/);
    assert.ok(markdown.indexOf('## #1 run.start') < markdown.indexOf('## 完整 messages'));
  });
});

describe('trace：fs.write 与快照', () => {
  it('覆盖已有文件时记录前后 sha256，快照文件真实存在且是原内容', async () => {
    const sandbox = path.join(baseDir, 'fs-sandbox');
    const traceRoot = path.join(baseDir, 'fs-trace');
    await mkdir(sandbox, { recursive: true });
    await writeFile(path.join(sandbox, 'notes.txt'), '旧内容\n', 'utf8');

    const sink = new MarkdownSink({ dir: traceRoot, runId: 'fs-write' });
    const model = new ScriptedModel([
      toolCallStep(
        'write_file',
        JSON.stringify({ path: 'notes.txt', content: '新内容\n', overwrite: true }),
        'call_write',
      ),
      finalStep('写好了。'),
    ]);
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      rootDir: sandbox,
      traceSink: sink,
    });

    const result = await loop.run('把 notes.txt 改成新内容');
    assert.equal(result.stopReason, 'final');

    const markdown = await readFile(sink.filePath, 'utf8');
    const events = parseEvents(markdown);
    const writeEvent = events.find((event) => event.type === 'fs.write');
    assert.ok(writeEvent, 'trace 里要有 fs.write 事件');
    if (writeEvent.type !== 'fs.write') throw new Error('事件类型不对');

    assert.equal(writeEvent.operation, 'fs.write');
    assert.equal(writeEvent.path, 'notes.txt');
    assert.equal(writeEvent.overwritten, true);
    assert.equal(writeEvent.allowed, true);
    assert.equal(writeEvent.bytes, Buffer.byteLength('新内容\n', 'utf8'));
    assert.equal(writeEvent.beforeSha256, sha256Hex('旧内容\n'));
    assert.equal(writeEvent.afterSha256, sha256Hex('新内容\n'));
    assert.equal(writeEvent.snapshot, 'snapshots/1-notes.txt');

    // 快照文件真实存在，内容是覆盖前的原文
    const snapshotPath = path.join(sink.dir, 'snapshots', '1-notes.txt');
    assert.equal(await readFile(snapshotPath, 'utf8'), '旧内容\n');
    assert.equal(await readFile(path.join(sandbox, 'notes.txt'), 'utf8'), '新内容\n');

    // 文件里的 Markdown 也能人读：一节一事件
    assert.match(markdown, /## #\d+ fs\.write（turn 1）/);
    assert.match(markdown, /字节：\d+，覆盖已有文件，allowed=true/);
  });

  it('新建文件不抓快照，只记 afterSha256', async () => {
    const sandbox = path.join(baseDir, 'fs-new');
    const traceRoot = path.join(baseDir, 'fs-new-trace');
    await mkdir(sandbox, { recursive: true });

    const sink = new MarkdownSink({ dir: traceRoot, runId: 'fs-new' });
    const model = new ScriptedModel([
      toolCallStep('write_file', JSON.stringify({ path: 'fresh.txt', content: 'hello\n' }), 'call_new'),
      finalStep('建好了。'),
    ]);
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      rootDir: sandbox,
      traceSink: sink,
    });

    await loop.run('新建 fresh.txt');

    const events = parseEvents(await readFile(sink.filePath, 'utf8'));
    const writeEvent = events.find((event) => event.type === 'fs.write');
    assert.ok(writeEvent && writeEvent.type === 'fs.write');
    assert.equal(writeEvent.overwritten, false);
    assert.equal(writeEvent.beforeSha256, undefined);
    assert.equal(writeEvent.snapshot, undefined);
    assert.equal(writeEvent.afterSha256, sha256Hex('hello\n'));
  });
});

describe('trace：压缩与记忆事件', () => {
  it('context.compact 与 memory.inject 在真实 loop 流程里各发一条', async () => {
    const sink = new RecordingSink();
    const memory = new MemoryStore({ dir: path.join(baseDir, 'memory') });
    await memory.append({ text: '用户偏向后端用 TypeScript', tag: '偏好' });

    const summarizer = new FakeSummarizer();
    const history: Message[] = [];
    for (let turn = 1; turn <= 8; turn += 1) {
      history.push({ role: 'user', content: `历史问题 ${turn}` });
      history.push({ role: 'assistant', content: `历史回答 ${turn}` });
    }

    const model = new ScriptedModel([finalStep('建议继续用 TypeScript。')]);
    const loop = new AgentLoop({
      model,
      registry: new ToolRegistry(),
      memory,
      history,
      context: new ContextEngine({ summarizer, maxMessages: 5 }),
      traceSink: sink,
    });

    const result = await loop.run('后端语言推荐 TypeScript 还是 Go？');
    assert.equal(result.stopReason, 'final');
    assert.equal(summarizer.prompts.length, 1, '第 2 层应该真的调用了摘要器');

    const compactEvents = sink.events.filter((event) => event.type === 'context.compact');
    assert.equal(compactEvents.length, 1);
    const compact = compactEvents[0]!;
    if (compact.type !== 'context.compact') throw new Error('事件类型不对');
    assert.ok(compact.layers.layer2 >= 1, `layer2 应该生效：${JSON.stringify(compact.layers)}`);
    assert.ok(compact.charsBefore > compact.charsAfter);
    assert.ok(compact.estimatedTokens > 0);
    assert.ok(compact.dropped >= 1, '至少丢掉中段里的一部分消息');
    assert.ok(compact.notes.length > 0);
    assert.equal(compact.turn, 1);

    const injectEvents = sink.events.filter((event) => event.type === 'memory.inject');
    assert.equal(injectEvents.length, 1);
    const inject = injectEvents[0]!;
    if (inject.type !== 'memory.inject') throw new Error('事件类型不对');
    assert.equal(inject.hitCount, 1);
    assert.equal(inject.query, '后端语言推荐 TypeScript 还是 Go？');
    assert.match(inject.summary, /TypeScript/);

    const reply = sink.events.find((event) => event.type === 'model.reply');
    assert.ok(reply && reply.type === 'model.reply');
    assert.equal(reply.compressed, true, 'model.reply 要标明本轮压缩过');
    assert.equal(reply.memoryHits, 1);

    // 事件顺序：先记忆注入，再压缩，再调模型
    const order = sink.events.map((event) => event.type);
    assert.ok(order.indexOf('memory.inject') < order.indexOf('context.compact'));
    assert.ok(order.indexOf('context.compact') < order.indexOf('model.reply'));
  });
});

describe('trace：不影响对话本身', () => {
  it('配不配 sink，answer / stopReason / messages 完全一致', async () => {
    const steps = (): Step[] => [
      toolCallStep('calculator', JSON.stringify({ expression: '6 * 7' }), 'call_mul'),
      finalStep('结果是 42。'),
    ];

    const plain = await new AgentLoop({
      model: new ScriptedModel(steps()),
      registry: createDefaultRegistry(),
    }).run('算一下 6*7');

    const sink = new RecordingSink();
    const tracedModel = new ScriptedModel(steps());
    const traced = await new AgentLoop({
      model: tracedModel,
      registry: createDefaultRegistry(),
      traceSink: sink,
    }).run('算一下 6*7');

    assert.ok(sink.events.length > 0, 'sink 应该真的收到事件');
    assert.equal(traced.answer, plain.answer);
    assert.equal(traced.stopReason, plain.stopReason);
    assert.equal(traced.turns, plain.turns);
    assert.deepEqual(contentOf(traced.messages), contentOf(plain.messages));
    assert.deepEqual(
      traced.trace.map((entry) => entry.kind),
      plain.trace.map((entry) => entry.kind),
    );

    // trace 不进模型上下文：发给模型的消息里没有 trace 文件相关内容
    const sent = tracedModel.calls.flat();
    assert.ok(!sent.some((message) => message.content.includes('.trace/')));
    assert.ok(!sent.some((message) => message.content.includes('trace.markdown')));
    // 不新增工具位：默认工具集里没有 read_trace
    assert.ok(!createDefaultRegistry().list().some((tool) => tool.name === 'read_trace'));
  });
});
