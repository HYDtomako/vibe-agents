/**
 * Context Engineering 测试：三层压缩各自触发、近零开销、配对完整、兜底不抛。
 *
 * 摘要器用注入的假 ModelClient，不联网。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AgentLoop } from '../src/loop.js';
import {
  ContextEngine,
  MEMORY_MARKER,
  SUMMARY_MARKER,
  countTurns,
  estimateMessagesTokens,
  estimateTokens,
  splitTurns,
} from '../src/context.js';
import { defineTool, toolOk } from '../src/tools/base.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { Message, ModelClient, ModelResponse } from '../src/types.js';

/** 假摘要器：记录调用次数与收到的 prompt */
class FakeSummarizer implements ModelClient {
  readonly prompts: string[] = [];

  constructor(private readonly impl: (prompt: string) => Promise<ModelResponse> | ModelResponse) {}

  async chat(messages: Message[]): Promise<ModelResponse> {
    const prompt = messages.map((message) => message.content).join('\n');
    this.prompts.push(prompt);
    return this.impl(prompt);
  }

  get calls(): number {
    return this.prompts.length;
  }
}

function summaryStep(text: string): ModelResponse {
  return { content: text, toolCalls: [] };
}

interface ConversationOptions {
  /** 指定轮次（1 起始）的 tool 消息内容用超长文本 */
  bigToolTurns?: number[];
  /** 指定轮次（1 起始）的 toolCalls 参数用超长文本 */
  bigArgsTurns?: number[];
  toolContentLength?: number;
  argsLength?: number;
  /** 只生成 user + assistant 两条消息，用于单独验证「轮次」阈值 */
  compactTurns?: boolean;
}

function makeConversation(turns: number, options: ConversationOptions = {}): Message[] {
  const bigTool = new Set(options.bigToolTurns ?? []);
  const bigArgs = new Set(options.bigArgsTurns ?? []);
  const toolLength = options.toolContentLength ?? 2000;
  const argsLength = options.argsLength ?? 800;

  const messages: Message[] = [{ role: 'system', content: '你是测试用的 system 提示' }];
  for (let turn = 1; turn <= turns; turn += 1) {
    messages.push({ role: 'user', content: `第 ${turn} 轮用户问题` });
    if (options.compactTurns) {
      messages.push({ role: 'assistant', content: `第 ${turn} 轮结论` });
      continue;
    }
    const args = bigArgs.has(turn)
      ? JSON.stringify({ pattern: 'x'.repeat(argsLength) })
      : JSON.stringify({ pattern: `p${turn}` });
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `call_${turn}`, name: 'grep', arguments: args }],
    });
    messages.push({
      role: 'tool',
      name: 'grep',
      toolCallId: `call_${turn}`,
      content: bigTool.has(turn) ? 'T'.repeat(toolLength) : JSON.stringify({ ok: true, output: `结果 ${turn}` }),
    });
    messages.push({ role: 'assistant', content: `第 ${turn} 轮结论` });
  }
  return messages;
}

function findSummary(messages: Message[]): Message[] {
  return messages.filter(
    (message) => message.role === 'assistant' && message.content.startsWith(SUMMARY_MARKER),
  );
}

describe('token 估算与轮次切分', () => {
  it('ASCII 按 4 字符 ≈ 1 token，CJK 按 1 字 ≈ 1 token', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcdefgh'), 2);
    assert.equal(estimateTokens('中文四字'), 4);
    assert.ok(estimateMessagesTokens(makeConversation(1)) > 0);
  });

  it('splitTurns 把开头连续的 system（含 [相关记忆]）都算作前缀', () => {
    const messages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'system', content: `${MEMORY_MARKER} - 记忆一条` },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ];
    const { prefix, groups } = splitTurns(messages);
    assert.equal(prefix.length, 2);
    assert.equal(groups.length, 2);
    assert.equal(countTurns(messages), 2);
  });
});

describe('第 1 层：老消息降载', () => {
  it('最近 3 轮原样保留，更老的 tool 消息裁成首 600 + 尾 300', async () => {
    const summarizer = new FakeSummarizer(() => summaryStep('不该被调用'));
    const engine = new ContextEngine({ summarizer });
    const messages = makeConversation(5, { bigToolTurns: [1, 5] });

    const fit = await engine.fit(messages);

    assert.equal(fit.stats.layer1Trimmed, 1);
    assert.equal(summarizer.calls, 0);
    assert.equal(fit.messages.length, messages.length, '第 1 层只降载、不删消息');

    const oldTool = fit.messages.find((message) => message.toolCallId === 'call_1')!;
    assert.match(oldTool.content, /…\[已裁剪 \d+ 字符\]/);
    assert.ok(oldTool.content.length < 2000);
    assert.match(oldTool.content, /^T{600}/);

    // 最近 3 轮（第 3/4/5 轮）里的超长 tool 消息不动
    const recentTool = fit.messages.find((message) => message.toolCallId === 'call_5')!;
    assert.equal(recentTool.content.length, 2000);

    assert.ok(fit.stats.charsAfter < fit.stats.charsBefore);
    // 原数组未被就地改动
    assert.equal(messages.find((message) => message.toolCallId === 'call_1')!.content.length, 2000);
  });

  it('assistant 的 toolCalls.arguments 超 400 字符时裁剪，但保留 id/name 保证配对', async () => {
    const engine = new ContextEngine({ summarizer: new FakeSummarizer(() => summaryStep('x')) });
    const messages = makeConversation(5, { bigArgsTurns: [1] });

    const fit = await engine.fit(messages);
    const call = fit.messages.find((message) => message.toolCalls?.[0]?.id === 'call_1')!.toolCalls![0]!;

    assert.equal(call.id, 'call_1');
    assert.equal(call.name, 'grep');
    assert.match(call.arguments, /…\[参数已裁剪\]$/);
    assert.ok(call.arguments.length < 800);

    // 与它配对的 tool 消息仍在
    assert.ok(fit.messages.some((message) => message.role === 'tool' && message.toolCallId === 'call_1'));
  });

  it('低于 1200 字符的 tool 内容不动', async () => {
    const engine = new ContextEngine({ summarizer: new FakeSummarizer(() => summaryStep('x')) });
    const messages = makeConversation(5, { bigToolTurns: [1], toolContentLength: 1100 });
    const fit = await engine.fit(messages);
    assert.equal(fit.stats.layer1Trimmed, 0);
    assert.doesNotMatch(
      fit.messages.find((message) => message.toolCallId === 'call_1')!.content,
      /已裁剪/,
    );
  });

  it('连续两次 fit 不会重复裁剪（标记不被二次吃掉）', async () => {
    const engine = new ContextEngine({ summarizer: new FakeSummarizer(() => summaryStep('x')) });
    const messages = makeConversation(5, { bigToolTurns: [1] });
    const first = await engine.fit(messages);
    const second = await engine.fit(first.messages);
    const oldTool = second.messages.find((message) => message.toolCallId === 'call_1')!;
    assert.equal((oldTool.content.match(/已裁剪/g) ?? []).length, 1);
  });
});

describe('第 2 层：超阈值摘要', () => {
  it('消息数超阈值时触发，保留最近 6 轮并只留一条 [历史摘要]', async () => {
    const summarizer = new FakeSummarizer(() => summaryStep('用户在做上下文压缩实验，已完成前 20 轮。'));
    const engine = new ContextEngine({ summarizer });
    const messages = makeConversation(20);

    const fit = await engine.fit(messages);

    assert.equal(summarizer.calls, 1);
    assert.ok(fit.stats.layer2Compressed > 0);
    assert.equal(fit.stats.layer3Fallback, 0);

    const summaries = findSummary(fit.messages);
    assert.equal(summaries.length, 1);
    assert.match(summaries[0]!.content, /^\[历史摘要\] 用户在做上下文压缩实验/);

    // system 仍在首位
    assert.equal(fit.messages[0]!.role, 'system');
    // 最近 6 轮原样保留
    const recentUsers = fit.messages.filter((message) => message.role === 'user').slice(-6);
    assert.deepEqual(
      recentUsers.map((message) => message.content),
      ['第 15 轮用户问题', '第 16 轮用户问题', '第 17 轮用户问题', '第 18 轮用户问题', '第 19 轮用户问题', '第 20 轮用户问题'],
    );
    assert.ok(fit.stats.charsAfter < fit.stats.charsBefore);
  });

  it('轮次超阈值（> 15）也能触发', async () => {
    const summarizer = new FakeSummarizer(() => summaryStep('十六轮之后的摘要'));
    const engine = new ContextEngine({ summarizer });
    const messages = makeConversation(16, { compactTurns: true });

    assert.ok(messages.length < 40, '这个用例刻意不靠消息数触发');
    const fit = await engine.fit(messages);
    assert.equal(summarizer.calls, 1);
    assert.equal(findSummary(fit.messages).length, 1);
  });

  it('token 估算超阈值也能触发', async () => {
    const summarizer = new FakeSummarizer(() => summaryStep('token 触发的摘要'));
    const engine = new ContextEngine({ summarizer, maxTokens: 1200 });
    const messages = makeConversation(12, { bigToolTurns: [4, 5, 6, 7, 8], toolContentLength: 2000 });

    const fit = await engine.fit(messages);
    assert.equal(summarizer.calls, 1);
    assert.ok(fit.stats.layer2Compressed > 0);
    assert.equal(findSummary(fit.messages).length, 1);
  });

  it('连续两次 fit 会把已有摘要与新增中段一起重压，不堆叠', async () => {
    const texts = ['第一版摘要内容', '第二版'];
    const summarizer = new FakeSummarizer((prompt) =>
      summaryStep(prompt.includes('第一版摘要内容') ? texts[1]! : texts[0]!),
    );
    const engine = new ContextEngine({ summarizer });
    const messages = makeConversation(20);

    const first = await engine.fit(messages);
    assert.equal(findSummary(first.messages).length, 1);

    const second = await engine.fit(first.messages, { turnCount: 16 });
    const summaries = findSummary(second.messages);
    assert.equal(summaries.length, 1, '不允许出现两条 [历史摘要]');
    assert.match(summaries[0]!.content, /第二版/);
    assert.match(summarizer.prompts.at(-1)!, /第一版摘要内容/, '已有摘要要进入重压输入');
  });

  it('未超阈值时近零开销：不调摘要器、stats 全 0、消息不变', async () => {
    const summarizer = new FakeSummarizer(() => summaryStep('不该被调用'));
    const engine = new ContextEngine({ summarizer });
    const messages = makeConversation(3);

    const fit = await engine.fit(messages);

    assert.equal(summarizer.calls, 0);
    assert.equal(fit.stats.layer2Compressed, 0);
    assert.equal(fit.stats.layer3Fallback, 0);
    assert.equal(fit.stats.layer1Trimmed, 0);
    assert.equal(fit.messages.length, messages.length);
    assert.equal(fit.stats.charsBefore, fit.stats.charsAfter);
    assert.deepEqual(fit.messages, messages);
  });

  it('[相关记忆] 前缀在第 2 层压缩后仍然存在', async () => {
    const summarizer = new FakeSummarizer(() => summaryStep('压缩摘要'));
    const engine = new ContextEngine({ summarizer });
    const messages = makeConversation(20);
    messages.splice(1, 0, { role: 'system', content: `${MEMORY_MARKER}\n- (2026-02-01) [#fact] 用户偏好 TypeScript` });

    const fit = await engine.fit(messages);
    assert.equal(fit.messages[0]!.role, 'system');
    assert.match(fit.messages[1]!.content, /\[相关记忆\]/);
    assert.equal(findSummary(fit.messages).length, 1);
  });
});

describe('第 3 层：兜底（绝不抛异常）', () => {
  const failures: Array<[string, (prompt: string) => Promise<ModelResponse> | ModelResponse]> = [
    ['摘要器抛错', () => { throw new Error('摘要服务 500'); }],
    ['摘要返回空', () => summaryStep('   ')],
    [
      '摘要超时',
      () =>
        new Promise<ModelResponse>(() => {
          // 永远不 resolve，靠 summaryTimeoutMs 兜底
        }),
    ],
  ];

  for (const [name, impl] of failures) {
    it(`${name}时走兜底且不抛异常`, async () => {
      const summarizer = new FakeSummarizer(impl);
      const engine = new ContextEngine({ summarizer, summaryTimeoutMs: 20 });
      const messages = makeConversation(20);

      const fit = await engine.fit(messages);

      assert.equal(fit.stats.layer3Fallback, 1);
      assert.equal(fit.stats.layer2Compressed, 0);
      assert.equal(findSummary(fit.messages).length, 1);
      assert.match(findSummary(fit.messages)[0]!.content, /\[历史摘要\]/);
      assert.ok(fit.notes.some((note) => /layer3/.test(note)));
      // 最近 12 轮仍在
      const recentUsers = fit.messages.filter((message) => message.role === 'user');
      assert.equal(recentUsers.length, 12);
      assert.equal(recentUsers.at(-1)!.content, '第 20 轮用户问题');
    });
  }

  it('摘要比原中段还长时也算失败并走兜底', async () => {
    const engine = new ContextEngine({
      summarizer: new FakeSummarizer(() => summaryStep('长'.repeat(5000))),
    });
    const fit = await engine.fit(makeConversation(20));
    assert.equal(fit.stats.layer3Fallback, 1);
    assert.match(fit.notes.join('；'), /未小于原中段/);
  });

  it('已有 [历史摘要] 时兜底复用它，不再写第二条', async () => {
    const engine = new ContextEngine({
      summarizer: new FakeSummarizer(() => {
        throw new Error('坏了');
      }),
    });
    const messages = makeConversation(20);
    messages.splice(1, 0, { role: 'assistant', content: `${SUMMARY_MARKER} 之前压好的摘要` });

    const fit = await engine.fit(messages);
    const summaries = findSummary(fit.messages);
    assert.equal(summaries.length, 1);
    assert.match(summaries[0]!.content, /之前压好的摘要/);
  });

  it('fit 后仍超 MAX_TOKENS 时从老到新继续丢，保底 system + 最近 2 轮', async () => {
    const engine = new ContextEngine({
      summarizer: new FakeSummarizer(() => summaryStep('摘要')),
      maxTokens: 200,
      minKeepTurns: 2,
    });
    const messages = makeConversation(12, { bigToolTurns: [7, 8, 9, 10, 11, 12], toolContentLength: 1500 });

    const fit = await engine.fit(messages);

    assert.equal(fit.stats.layer3Fallback, 1);
    assert.equal(fit.messages[0]!.role, 'system');
    const users = fit.messages.filter((message) => message.role === 'user');
    assert.ok(users.length >= 2 && users.length <= 3, `兜底后应只剩最后 2-3 轮，实际 ${users.length}`);
    assert.equal(users.at(-1)!.content, '第 12 轮用户问题');
    assert.ok(fit.notes.some((note) => /预算兜底/.test(note)));
  });
});

describe('loop 集成：压缩结果写进 trace note', () => {
  it('第 2 层生效时 note 里能看到 layer2 与节省量', async () => {
    const summarizer = new FakeSummarizer(() => summaryStep('历史摘要'));
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'big',
        description: '返回一大段文本',
        parameters: { type: 'object', properties: {} },
        todo: ['返回长文本，用于验证 loop 的上下文压缩接线'],
        async run() {
          return toolOk('B'.repeat(500));
        },
      }),
    );

    const steps: ModelResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'big', arguments: '{}' }] },
      { content: '完成', toolCalls: [] },
    ];
    let index = 0;
    const model: ModelClient = {
      async chat() {
        const step = steps[Math.min(index, steps.length - 1)]!;
        index += 1;
        return step;
      },
    };

    const history: Message[] = [];
    for (let turn = 1; turn <= 8; turn += 1) {
      history.push({ role: 'user', content: `历史问题 ${turn}` });
      history.push({ role: 'assistant', content: `历史回答 ${turn}` });
    }

    const loop = new AgentLoop({
      model,
      registry,
      history,
      context: new ContextEngine({ summarizer, maxMessages: 5 }),
    });

    const result = await loop.run('现在开始');

    assert.equal(result.stopReason, 'final');
    const modelEntry = result.trace.find((entry) => entry.kind === 'model')!;
    assert.match(modelEntry.note ?? '', /layer2=\d+/);
    assert.match(modelEntry.note ?? '', /chars \d+->\d+/);
  });
});
