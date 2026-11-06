/**
 * 记忆层测试：Markdown 持久化、词面检索、loop 注入与压缩后的存活。
 *
 * 全部写在 os.tmpdir() 下，不碰项目里的 memory/；模型与摘要器都是假实现。
 * 记忆是全局单文件（<dir>/cli.md），不按会话派生。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ContextEngine, MEMORY_MARKER, SUMMARY_MARKER } from '../src/context.js';
import { AgentLoop } from '../src/loop.js';
import { MemoryError, MemoryStore, formatMemoryForPrompt, parseMemoryLine, rememberTool, tokenizeQuery } from '../src/memory.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { Message, ModelClient, ModelResponse, ToolSpec } from '../src/types.js';

let baseDir = '';

function freshDir(name: string): string {
  return path.join(baseDir, name);
}

function store(name: string, options: { maxEntries?: number; now?: () => Date; topK?: number } = {}): MemoryStore {
  return new MemoryStore({
    dir: freshDir(name),
    ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.topK !== undefined ? { topK: options.topK } : {}),
  });
}

/** 记录每次调用的假模型 */
class RecordingModel implements ModelClient {
  readonly calls: Message[][] = [];

  constructor(private readonly steps: ModelResponse[]) {}

  async chat(messages: Message[], _tools?: ToolSpec[]): Promise<ModelResponse> {
    this.calls.push(messages.map((message) => ({ ...message })));
    return this.steps[Math.min(this.calls.length - 1, this.steps.length - 1)]!;
  }
}

const finalStep = (text: string): ModelResponse => ({ content: text, toolCalls: [] });

before(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'mini-agent-memory-'));
});

after(async () => {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
});

describe('MemoryStore：写入', () => {
  it('自动创建目录并按 `- [YYYY-MM-DD HH:mm] #tag 内容` 落盘', async () => {
    const memory = store('append-format');
    const result = await memory.append({ text: '用户偏好 TypeScript', tag: '偏好', kind: 'preference' });

    assert.equal(result.added, true);
    assert.equal(result.count, 1);
    assert.equal(existsSync(freshDir('append-format')), true);
    // 记忆全局共享：文件名固定 cli.md，不按会话派生
    assert.equal(memory.filePath, path.join(freshDir('append-format'), 'cli.md'));

    const raw = await readFile(memory.filePath, 'utf8');
    assert.match(raw, /^- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] #preference #偏好 用户偏好 TypeScript\n$/);
  });

  it('没有 tag 时用 kind 作为标签', async () => {
    const memory = store('append-kind');
    await memory.append({ text: '记住了 42', kind: 'fact' });
    const raw = await readFile(memory.filePath, 'utf8');
    assert.match(raw, /\] #fact 记住了 42/);
  });

  it('内容重复时去重，不重复写行', async () => {
    const memory = store('append-dedup');
    await memory.append({ text: '同一句话' });
    const second = await memory.append({ text: '  同一句话  ' });
    assert.equal(second.added, false);
    assert.equal(second.count, 1);
    assert.equal((await readFile(memory.filePath, 'utf8')).trim().split('\n').length, 1);
  });

  it('超过条数上限时抛 MemoryError', async () => {
    const memory = store('append-limit', { maxEntries: 2 });
    await memory.append({ text: '第一条' });
    await memory.append({ text: '第二条' });
    await assert.rejects(() => memory.append({ text: '第三条' }), MemoryError);
  });

  it('空内容直接拒绝', async () => {
    const memory = store('append-empty');
    await assert.rejects(() => memory.append({ text: '   ' }), MemoryError);
  });

  it('list() 能解析出时间/kind/tag/内容/行号', async () => {
    const memory = store('append-list');
    await memory.append({ text: '部署流水线用 esbuild', tag: '构建', kind: 'fact' });
    const entries = await memory.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.kind, 'fact');
    assert.equal(entries[0]!.tag, '构建');
    assert.equal(entries[0]!.content, '部署流水线用 esbuild');
    assert.equal(entries[0]!.line, 1);
    assert.match(entries[0]!.timestamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('parseMemoryLine 忽略不符合格式的行', () => {
    assert.equal(parseMemoryLine('# 标题', 'f.md', 1), null);
    assert.equal(parseMemoryLine('- [2026-01-01 10:00] #fact', 'f.md', 1), null);
    assert.ok(parseMemoryLine('- [2026-01-01 10:00] #fact 有内容', 'f.md', 3));
  });
});

describe('MemoryStore：检索', () => {
  it('中文按 2-gram 命中', async () => {
    const memory = store('search-zh');
    await memory.append({ text: '用户偏好使用 TypeScript 写后端服务', tag: '偏好' });
    await memory.append({ text: '周五要交季度报表', tag: '待办' });

    // 全局记忆：目录里其它 Markdown（历史遗留的按会话文件）同样参与召回
    const legacyFile = path.join(freshDir('search-zh'), 'legacy-work.md');
    await writeFile(legacyFile, '- [2026-01-01 10:00] #fact 灰度发布比例百分之五\n', 'utf8');
    const legacyHits = await memory.search('灰度发布比例');
    assert.equal(legacyHits.length, 1);
    assert.equal(legacyHits[0]!.file, legacyFile);

    const hits = await memory.search('后端用什么语言');
    assert.ok(hits.length >= 1);
    assert.match(hits[0]!.content, /TypeScript/);
  });

  it('英文按单词命中', async () => {
    const memory = store('search-en');
    await memory.append({ text: 'The deploy pipeline uses esbuild for bundling' });
    const hits = await memory.search('deploy pipeline');
    assert.ok(hits.length >= 1);
    assert.match(hits[0]!.content, /deploy pipeline/i);
  });

  it('#tag 命中加权：同内容同时间下带 tag 的排前面', async () => {
    const memory = store('search-tag');
    await memory.append({ text: 'alpha beta gamma', tag: 'topic' });
    await memory.append({ text: 'alpha beta gamma two', tag: 'other' });

    const hits = await memory.search('topic alpha beta');
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.tag, 'topic');
    assert.ok(hits[0]!.score > hits[1]!.score);
  });

  it('时间近因衰减：更晚写入的排前面', async () => {
    let current = new Date('2026-01-01T00:00:00');
    const memory = store('search-recency', { now: () => new Date(current) });
    await memory.append({ text: '项目决策 使用 npm' });
    current = new Date('2026-03-01T00:00:00');
    await memory.append({ text: '项目决策 使用 pnpm' });

    const hits = await memory.search('项目决策');
    assert.equal(hits.length, 2);
    assert.match(hits[0]!.content, /pnpm/);
    assert.ok(hits[0]!.score > hits[1]!.score);
  });

  it('topK 生效，且按分数倒序', async () => {
    const memory = store('search-topk');
    for (let index = 1; index <= 6; index += 1) {
      await memory.append({ text: `缓存策略 方案 ${index}` });
    }
    const hits = await memory.search('缓存策略', { topK: 3 });
    assert.equal(hits.length, 3);
    for (let index = 1; index < hits.length; index += 1) {
      assert.ok(hits[index - 1]!.score >= hits[index]!.score);
    }
  });

  it('空 query 返回空数组', async () => {
    const memory = store('search-empty');
    await memory.append({ text: '随便一条' });
    assert.deepEqual(await memory.search(''), []);
    assert.deepEqual(await memory.search('   '), []);
  });

  it('无命中返回空数组（不是报错）', async () => {
    const memory = store('search-miss');
    await memory.append({ text: '无关内容' });
    assert.deepEqual(await memory.search('量子纠缠退相干'), []);
  });

  it('目录不存在时检索返回空而不是抛错', async () => {
    const memory = store('search-nowhere');
    assert.deepEqual(await memory.search('任何东西'), []);
  });

  it('tokenizeQuery 去停用词并切中文 2-gram', () => {
    assert.deepEqual(tokenizeQuery('the deploy pipeline'), ['deploy', 'pipeline']);
    assert.ok(tokenizeQuery('用户偏好').includes('用户'));
    assert.ok(tokenizeQuery('用户偏好').includes('偏好'));
    assert.deepEqual(tokenizeQuery('的了吗呢'), []);
  });

  it('formatMemoryForPrompt 带日期与 tag', () => {
    const text = formatMemoryForPrompt([
      {
        timestamp: '2026-02-01 09:30',
        kind: 'fact',
        tag: '偏好',
        tags: ['fact', '偏好'],
        content: '用户偏好 TypeScript',
        file: 'f.md',
        line: 1,
        score: 2,
      },
    ]);
    assert.equal(text, '[相关记忆]\n- (2026-02-01) [#偏好] 用户偏好 TypeScript');
  });
});

describe('remember 工具', () => {
  it('写入成功时返回路径与当前条数', async () => {
    const memory = store('remember-ok');
    const result = await rememberTool.run(
      { text: '用户希望回复简短', tag: '风格', kind: 'preference' },
      { toolName: 'remember', memory },
    );
    assert.equal(result.ok, true);
    assert.match(result.output, /已写入记忆/);
    assert.match(result.output, /当前 1 条/);
    assert.equal(await memory.count(), 1);
  });

  it('未配置记忆存储时返回 ok=false', async () => {
    const result = await rememberTool.run({ text: 'x' }, { toolName: 'remember' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'MEMORY_UNAVAILABLE');
  });

  it('text 为空时返回 ok=false', async () => {
    const result = await rememberTool.run({ text: '  ' }, { toolName: 'remember', memory: store('remember-empty') });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'TEXT_REQUIRED');
  });
});

describe('loop 注入', () => {
  it('命中时在 system 前缀之后插入一条 [相关记忆]', async () => {
    const memory = store('loop-inject');
    await memory.append({ text: '用户偏好使用 TypeScript 写后端', tag: '偏好' });

    const model = new RecordingModel([finalStep('好的')]);
    const loop = new AgentLoop({ model, registry: new ToolRegistry(), memory });

    const result = await loop.run('后端语言推荐什么？');

    assert.equal(result.stopReason, 'final');
    const sent = model.calls[0]!;
    assert.equal(sent[0]!.role, 'system');
    assert.ok(sent[0]!.content.includes('最小可用的 agent'), '系统提示仍在最前');
    assert.equal(sent[1]!.role, 'system');
    assert.match(sent[1]!.content, /^\[相关记忆\]/);
    assert.match(sent[1]!.content, /TypeScript/);
    assert.ok(sent.some((message) => message.content === '后端语言推荐什么？'));

    const modelEntry = result.trace.find((entry) => entry.kind === 'model')!;
    assert.match(modelEntry.note ?? '', /memory_hits=\d+/);
  });

  it('没有召回时不注入 [相关记忆]，note 里 memory_hits=0', async () => {
    const memory = store('loop-no-hit');
    await memory.append({ text: '完全无关的一条记忆' });

    const model = new RecordingModel([finalStep('好的')]);
    const loop = new AgentLoop({ model, registry: new ToolRegistry(), memory });
    const result = await loop.run('量子纠缠退相干');

    assert.ok(!model.calls[0]!.some((message) => message.content.startsWith(MEMORY_MARKER)));
    const modelEntry = result.trace.find((entry) => entry.kind === 'model')!;
    assert.match(modelEntry.note ?? '', /memory_hits=0/);
  });

  it('正常结束时自动写一条 kind=decision 记忆，重复运行去重', async () => {
    const memory = store('loop-decision');
    const model = new RecordingModel([finalStep('结论是 42')]);
    const loop = new AgentLoop({ model, registry: new ToolRegistry(), memory });

    await loop.run('记住这个结论');
    const entries = await memory.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.kind, 'decision');
    assert.match(entries[0]!.content, /用户目标：记住这个结论；结论：结论是 42/);

    await loop.run('记住这个结论');
    assert.equal((await memory.list()).length, 1, '同样内容不重复写入');
  });

  it('模型失败（stopReason != final）时不写 decision', async () => {
    const memory = store('loop-error');
    const failing: ModelClient = {
      async chat() {
        throw new Error('HTTP 500');
      },
    };
    const loop = new AgentLoop({
      model: failing,
      registry: new ToolRegistry(),
      memory,
      retry: { sleep: async () => {} },
    });
    const result = await loop.run('随便问问');
    assert.equal(result.stopReason, 'retry_exhausted');
    assert.equal(await memory.count(), 0);
  });

  it('压缩（第 2 层）之后 [相关记忆] 仍然保留在消息里', async () => {
    const memory = store('loop-compress');
    await memory.append({ text: '用户偏好使用 TypeScript 写后端', tag: '偏好' });

    const summarizer: ModelClient = {
      async chat() {
        return { content: '压缩后的历史摘要', toolCalls: [] };
      },
    };
    const model = new RecordingModel([finalStep('好的')]);
    const history: Message[] = [];
    for (let turn = 1; turn <= 8; turn += 1) {
      history.push({ role: 'user', content: `历史问题 ${turn}` });
      history.push({ role: 'assistant', content: `历史回答 ${turn}` });
    }

    const loop = new AgentLoop({
      model,
      registry: new ToolRegistry(),
      memory,
      context: new ContextEngine({ summarizer, maxMessages: 5 }),
    });

    await loop.run('后端语言推荐什么？', { history });

    const sent = model.calls[0]!;
    assert.ok(sent.some((message) => message.content.startsWith(MEMORY_MARKER)), '记忆不能被压缩丢掉');
    assert.ok(sent.some((message) => message.content.startsWith(SUMMARY_MARKER)), '第 2 层应已生效');
    assert.equal(
      sent.filter((message) => message.content.startsWith(MEMORY_MARKER)).length,
      1,
      '记忆消息只应出现一次',
    );
  });

  it('remember 工具经 registry 可写入（memory 通过上下文透传）', async () => {
    const memory = store('loop-remember-tool');
    const model = new RecordingModel([
      { content: '', toolCalls: [{ id: 'c1', name: 'remember', arguments: JSON.stringify({ text: '用户叫小张' }) }] },
      finalStep('记下了'),
    ]);
    const registry = new ToolRegistry();
    registry.register(rememberTool);
    const loop = new AgentLoop({ model, registry, memory });

    const result = await loop.run('我叫小张，记一下');
    assert.equal(result.stopReason, 'final');
    assert.equal(result.trace.filter((entry) => entry.kind === 'tool')[0]!.ok, true);
    const contents = (await memory.list()).map((entry) => entry.content);
    assert.ok(contents.includes('用户叫小张'));
  });
});
