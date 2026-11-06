/**
 * 离线上下文压缩演示：不联网、不需要 API key、不读 .env、不写 .trace / .sessions。
 *
 * 运行：npx tsx examples/compaction-demo.ts
 *
 * 只调用 src/context.ts 的公开 API（ContextEngine.fit / estimateMessagesTokens /
 * splitTurns / countTurns / SUMMARY_MARKER）与 src/types.ts 的类型；不走 loop、不碰 CLI。
 * 摘要器用假 ModelClient：第 2 层返回固定文本，第 3 层故意抛错，全部在进程内完成。
 */

import process from 'node:process';

import {
  ContextEngine,
  SUMMARY_MARKER,
  countTurns,
  estimateMessagesTokens,
  splitTurns,
} from '../src/context.js';
import type { FitResult } from '../src/context.js';
import type { Message, ModelClient, ModelResponse } from '../src/types.js';

const RULE = '─'.repeat(72);
const SYSTEM = '你是 mini-agent 的演示助手。回答简洁，需要看文件时先用工具。';

/** 假摘要器：固定返回文本（第 2 层）或抛错（第 3 层），不联网。 */
class FakeSummarizer implements ModelClient {
  calls = 0;
  readonly prompts: string[] = [];

  constructor(private readonly reply: () => ModelResponse) {}

  async chat(messages: Message[]): Promise<ModelResponse> {
    this.calls += 1;
    this.prompts.push(messages.map((message) => message.content).join('\n'));
    return this.reply();
  }
}

/** 固定摘要文本：长度远小于它要替换的中段，满足第 2 层的「必须更短」校验 */
const FIXED_SUMMARY =
  '用户目标是逐个检查 src/legacy 下的 handler 实现，已完成前 14 个文件的排查：' +
  '均导出 handler_* 函数，逻辑为输入 trim 后转大写，未发现副作用。' +
  '待办：剩余文件未看，结论尚未汇总。关键路径：src/legacy/handler-*.ts。';

// ---------- 造对话 ----------

interface ToolStep {
  name: string;
  arguments: string;
  output: string;
}

interface TurnSpec {
  question: string;
  answer: string;
  tool?: ToolStep;
}

function buildConversation(turns: readonly TurnSpec[]): Message[] {
  const start = Date.now() - turns.length * 60_000;
  const messages: Message[] = [{ role: 'system', content: SYSTEM, createdAt: start }];
  turns.forEach((turn, index) => {
    const id = `call_${index + 1}`;
    const createdAt = start + index * 60_000;
    messages.push({ role: 'user', content: turn.question, createdAt });
    const tool = turn.tool;
    if (tool) {
      messages.push({
        role: 'assistant',
        content: `我先用 ${tool.name} 看一下第 ${index + 1} 处。`,
        toolCalls: [{ id, name: tool.name, arguments: tool.arguments }],
        createdAt,
      });
      messages.push({
        role: 'tool',
        name: tool.name,
        toolCallId: id,
        content: tool.output,
        createdAt,
      });
    }
    messages.push({ role: 'assistant', content: turn.answer, createdAt });
  });
  return messages;
}

/** 约 2800 字符的「读文件」结果，超过第 1 层的 1200 字符阈值 */
function bigFileContent(turn: number, lines = 28): string {
  const rows: string[] = [];
  for (let index = 1; index <= lines; index += 1) {
    rows.push(
      `${String(index).padStart(3, ' ')}: export const handler_${turn}_${index} = (input: string) => input.trim().toUpperCase();`,
    );
  }
  return rows.join('\n');
}

/** 超过 400 字符的工具参数，用于演示 toolCalls.arguments 裁剪 */
function bigGrepArgs(turn: number): string {
  return JSON.stringify({
    path: 'src/legacy',
    pattern: `handler_${turn}`,
    glob: '*.ts',
    limit: 200,
    fields: Array.from({ length: 32 }, (_value, index) => `field_${index + 1}`),
  });
}

/** 约 120 字符的普通工具结果：不触发第 1 层裁剪 */
function smallToolOutput(turn: number): string {
  return JSON.stringify({
    ok: true,
    file: `src/legacy/handler-${turn}.ts`,
    lines: 120,
    summary: `第 ${turn} 个文件：导出 3 个函数，无副作用`,
  });
}

/** 场景 1：6 轮，前 2 轮带超长工具结果与超长参数 */
function layer1Conversation(): Message[] {
  const turns: TurnSpec[] = [];
  for (let index = 1; index <= 6; index += 1) {
    const big = index <= 2;
    turns.push({
      question: `第 ${index} 个问题：看看 src/legacy/handler-${index}.ts 的实现`,
      answer: `第 ${index} 个问题结论：逻辑清楚，先记下来。`,
      tool: {
        name: 'grep',
        arguments: big ? bigGrepArgs(index) : JSON.stringify({ pattern: `handler_${index}` }),
        output: big ? bigFileContent(index) : smallToolOutput(index),
      },
    });
  }
  return buildConversation(turns);
}

/** 场景 2/3：20 轮普通工具调用，消息数 81 条，足够触发第 2 层 */
function longConversation(turnsCount = 20): Message[] {
  const turns: TurnSpec[] = [];
  for (let index = 1; index <= turnsCount; index += 1) {
    turns.push({
      question: `第 ${index} 个问题：顺手看一眼 src/legacy/handler-${index}.ts`,
      answer: `第 ${index} 个问题结论：没问题，继续下一个。`,
      tool: {
        name: 'grep',
        arguments: JSON.stringify({ pattern: `handler_${index}`, path: 'src/legacy' }),
        output: smallToolOutput(index),
      },
    });
  }
  return buildConversation(turns);
}

/** 场景 4：12 轮，后 6 轮工具结果很长，用来把 token 预算撑破 */
function budgetConversation(): Message[] {
  const turns: TurnSpec[] = [];
  for (let index = 1; index <= 12; index += 1) {
    const big = index > 6;
    turns.push({
      question: `第 ${index} 个问题：把 handler-${index}.ts 完整读一遍`,
      answer: `第 ${index} 个问题结论：已读完，按原样保留。`,
      tool: {
        name: 'read_file',
        arguments: JSON.stringify({ path: `src/legacy/handler-${index}.ts`, limit: 2000 }),
        output: big ? bigFileContent(index, 40) : smallToolOutput(index),
      },
    });
  }
  return buildConversation(turns);
}

// ---------- 打印 ----------

function preview(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function findSummary(messages: readonly Message[]): string | undefined {
  return messages.find(
    (message) => message.role === 'assistant' && (message.content ?? '').startsWith(SUMMARY_MARKER),
  )?.content;
}

interface Scenario {
  title: string;
  trigger: string;
  before: readonly Message[];
  fit: FitResult;
  summarizer: FakeSummarizer;
  /** 额外的人读说明，逐行打印 */
  details: string[];
}

function printScenario(scenario: Scenario): void {
  const { before, fit } = scenario;
  const tokensBefore = estimateMessagesTokens(before);
  const tokensAfter = estimateMessagesTokens(fit.messages);
  const dropped = before.length - fit.messages.length;

  console.log('');
  console.log(RULE);
  console.log(scenario.title);
  console.log(RULE);
  console.log(`触发条件：${scenario.trigger}`);
  console.log('');
  console.log(`压缩前：${before.length} 条消息 / ${fit.stats.charsBefore} 字符 / 估算 ${tokensBefore} token`);
  console.log(`压缩后：${fit.messages.length} 条消息 / ${fit.stats.charsAfter} 字符 / 估算 ${tokensAfter} token`);
  console.log(
    `命中层级：layer1 裁剪 ${fit.stats.layer1Trimmed} 处，` +
      `layer2 压缩 ${fit.stats.layer2Compressed} 条消息，` +
      `layer3 兜底 ${fit.stats.layer3Fallback === 1 ? '触发' : '未触发'}`,
  );
  if (dropped > 0) console.log(`条目变化：净减 ${dropped} 条（中段被摘要替换，或整轮被丢弃）`);
  console.log(`摘要器调用：${scenario.summarizer.calls} 次（第 1 层不调模型）`);
  for (const line of scenario.details) console.log(line);
  console.log('fit().notes（引擎只为第 2/3 层写 notes；第 1 层只体现在 stats.layer1Trimmed）：');
  if (fit.notes.length === 0) console.log('  （无，说明第 2/3 层都没有触发）');
  for (const note of fit.notes) console.log(`  · ${note}`);
}

function printTrimSample(title: string, before: readonly Message[], after: readonly Message[]): void {
  const oldBefore = before.find((message) => (message.content ?? '').length > 1200);
  const oldAfter = after.find((message) => (message.content ?? '').includes('…[已裁剪'));
  if (!oldBefore || !oldAfter) return;
  console.log('');
  console.log(title);
  console.log(`  裁剪前：${oldBefore.content.length} 字符 | ${preview(oldBefore.content, 90)}`);
  console.log(`  裁剪后：${oldAfter.content.length} 字符 | ${preview(oldAfter.content, 90)}`);
}

function printGroups(label: string, messages: readonly Message[]): void {
  const { prefix, groups } = splitTurns(messages);
  console.log(`${label}：前缀 ${prefix.length} 条 system，${groups.length} 轮（轮次口径 ${countTurns(messages)}）`);
}

// ---------- 四个场景 ----------

async function demoLayer1(): Promise<{ hit: string; summary: string }> {
  const summarizer = new FakeSummarizer(() => ({ content: '不该被调用', toolCalls: [] }));
  const engine = new ContextEngine({ summarizer });
  const before = layer1Conversation();
  const fit = await engine.fit(before);

  printScenario({
    title: '场景 1 · 第 1 层：老消息降载（每轮都会跑，只瘦身不删消息）',
    trigger:
      '始终执行：最近 3 轮原样保留；更老的 tool 消息 ≥1200 字符才裁成「首 600 + 尾 300」，' +
      'toolCalls 参数 >400 字符截成「首 200 + 标记」。',
    before,
    fit,
    summarizer,
    details: [
      '看点：消息条数没变（第 1 层只改内容，不动序列），但字符数与 token 明显下降；',
      '越老的轮次越先被裁，最近 3 轮一律不动。',
    ],
  });
  printTrimSample('裁剪样例（最早一轮的 tool 消息）', before, fit.messages);
  const kept = fit.messages.filter((message) => message.role === 'tool').slice(-3);
  console.log(
    `最近 3 轮的 tool 消息长度：${kept.map((message) => message.content.length).join(' / ')} 字符（原样保留；它们本来也没超阈值）`,
  );

  return {
    hit: 'layer1',
    summary: `第 1 层：消息 ${before.length} → ${fit.messages.length} 条，估算 ${estimateMessagesTokens(before)} → ${estimateMessagesTokens(fit.messages)} token，裁剪 ${fit.stats.layer1Trimmed} 处`,
  };
}

async function demoLayer2(): Promise<{ hit: string; summary: string }> {
  const summarizer = new FakeSummarizer(() => ({ content: FIXED_SUMMARY, toolCalls: [] }));
  const engine = new ContextEngine({ summarizer });
  const before = longConversation(20);
  const fit = await engine.fit(before);
  const summary = findSummary(fit.messages);

  printScenario({
    title: '场景 2 · 第 2 层：超阈值摘要（system + 最近 6 轮保留，中段压成一条摘要）',
    trigger: '消息数 >40、估算 token >12000、轮次 >15，任一命中就触发。这里 81 条消息、20 轮，两条都命中。',
    before,
    fit,
    summarizer,
    details: [
      summary ? `摘要内容：${preview(summary, 160)}` : '摘要内容：（没有找到 [历史摘要]）',
      '看点：中段 14 轮（56 条）变成 1 条 [历史摘要]，最近 6 轮原样保留；',
      '摘要同一时间只允许存在一条：下次触发时会把已有摘要与新增中段一起重压，不会越堆越多。',
      '结构里压缩后是 7 轮 = 6 个用户轮次 + [历史摘要] 自己（它不是 user 开头，自成一组）。',
    ],
  });
  printGroups('压缩前结构', before);
  printGroups('压缩后结构', fit.messages);
  const recentUsers = fit.messages.filter((message) => message.role === 'user').slice(-6);
  console.log(`最近 6 轮的用户问题：${recentUsers.map((message) => message.content.slice(0, 8)).join(' | ')}`);
  console.log(`第 1 条消息仍是 system：${fit.messages[0]?.role === 'system'}`);
  const prompts = summarizer.prompts[0] ?? '';
  console.log(`摘要器收到的输入：${prompts.length} 字符（含「对话记录：」提示词 + 中段全文）`);

  return {
    hit: 'layer2',
    summary: `第 2 层：消息 ${before.length} → ${fit.messages.length} 条，估算 ${estimateMessagesTokens(before)} → ${estimateMessagesTokens(fit.messages)} token，中段压缩 ${fit.stats.layer2Compressed} 条`,
  };
}

async function demoLayer3Failure(): Promise<{ hit: string; summary: string }> {
  const summarizer = new FakeSummarizer(() => {
    throw new Error('摘要服务不可用（演示用）');
  });
  const engine = new ContextEngine({ summarizer });
  const before = longConversation(20);
  const fit = await engine.fit(before);
  const summary = findSummary(fit.messages);
  const droppedMessages = before.length - fit.messages.length;

  printScenario({
    title: '场景 3 · 第 3 层兜底：摘要器失败时不调模型，保留最近 12 轮 + 硬摘要',
    trigger:
      '第 2 层被触发但摘要器抛错 / 超时 / 返回空 / 摘要不比原中段短，就转入第 3 层；它绝不抛异常。',
    before,
    fit,
    summarizer,
    details: [
      summary ? `硬摘要：${preview(summary, 220)}` : '硬摘要：（没有找到 [历史摘要]）',
      '看点：没有模型参与，直接丢掉最早的 8 轮（32 条），保留最近 12 轮；',
      `净减 ${droppedMessages} 条 = 丢 32 条 - 补 1 条硬摘要（system 始终保留）；`,
      '硬摘要里记录了丢弃条数与首末消息时间，方便事后对账；余量不够时还会走预算兜底继续整轮丢。',
    ],
  });
  printGroups('压缩后结构', fit.messages);

  return {
    hit: 'layer3',
    summary: `第 3 层（摘要失败）：消息 ${before.length} → ${fit.messages.length} 条，估算 ${estimateMessagesTokens(before)} → ${estimateMessagesTokens(fit.messages)} token，丢弃 32 条`,
  };
}

async function demoLayer3Budget(): Promise<{ hit: string; summary: string }> {
  const summarizer = new FakeSummarizer(() => ({ content: '前半段已压缩。', toolCalls: [] }));
  // 只改预算阈值，用来演示「摘要做完仍然超预算」这一条兜底路径
  const engine = new ContextEngine({ summarizer, maxTokens: 1500, minKeepTurns: 2 });
  const before = budgetConversation();
  const fit = await engine.fit(before);
  const keptTurns = splitTurns(fit.messages).groups.length;

  printScenario({
    title: '场景 4 · 第 3 层预算兜底：摘要完仍超 maxTokens，从最早整轮丢到保底 2 轮',
    trigger:
      'fit 之后估算 token 仍 > maxTokens（本演示把上限压到 1500）时，从老到新整轮丢弃，' +
      '保底 system + 最近 2 轮。',
    before,
    fit,
    summarizer,
    details: [
      '看点：摘要不是终点，预算才是硬约束；这里最后一轮的工具结果 4000 字符，光它自己就接近上限。',
      `保留的轮数：${keptTurns} 轮（minKeepTurns = 2）。`,
    ],
  });
  printGroups('压缩后结构', fit.messages);

  return {
    hit: 'layer3',
    summary: `第 3 层（预算兜底）：消息 ${before.length} → ${fit.messages.length} 条，估算 ${estimateMessagesTokens(before)} → ${estimateMessagesTokens(fit.messages)} token，保留 ${keptTurns} 轮`,
  };
}

// ---------- 入口 ----------

async function main(): Promise<void> {
  console.log('上下文压缩离线演示 · 只用 src/context.ts 的公开 API + 假摘要器');
  console.log('不联网、不读 .env、不写 .trace / .sessions，数据全部在内存里。');
  console.log('场景 1~3 用默认阈值：消息数 40 / token 12000 / 轮次 15 / 第 2 层保留最近 6 轮；');
  console.log('场景 4 只把 maxTokens 压到 1500，用来触发「摘要后仍超预算」的兜底。');

  const results = [
    await demoLayer1(),
    await demoLayer2(),
    await demoLayer3Failure(),
    await demoLayer3Budget(),
  ];

  console.log('');
  console.log(RULE);
  console.log('小结（同一份对话在不同条件下命中的层级不同）');
  console.log(RULE);
  results.forEach((result, index) => {
    console.log(`  ${index + 1}. ${result.summary}`);
  });
  console.log('');
  console.log('对照记忆点：');
  console.log('  · 第 1 层每轮都跑，只降载、不删消息，所以消息数不变；');
  console.log('  · 第 2 层由「消息数 / token / 轮次」任一阈值触发，中段被摘要替换，消息数会明显下降；');
  console.log('  · 第 3 层是兜底：摘要不可用时硬丢到最近 12 轮，摘要后仍超预算时再整轮丢到保底 2 轮；');
  console.log('  · 三层都不会丢 system 前缀（含 [相关记忆]），也不会把 [历史摘要] 堆成多条。');
}

main().catch((error: unknown) => {
  console.error(`演示失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
