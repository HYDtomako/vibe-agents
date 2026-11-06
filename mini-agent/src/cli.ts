/**
 * 最小 REPL：读 stdin -> agent loop -> 打印回复（详细模式另附 trace 摘要）。
 *
 * - 默认输出只保留模型回答；trace 明细、usage 汇总、trace 落盘路径仅在
 *   「详细模式」下打印（启动参数 --verbose，或运行时 /verbose 切换）；
 * - 启动 banner 默认 1~2 行，其余信息（会话目录、记忆文件、trace 目录、命令清单）放在 /help；
 * - /trace 命令不受详细模式影响：显式调用时照旧打印上一轮完整 trace 与落盘路径；
 * - 凭据只从环境变量读（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL），
 *   启动时先加载当前工作目录的 .env（真实环境变量优先，文件里只补缺）；
 *   没有 LLM_API_KEY 时给出清晰提示：会话管理命令照常可用，只是不会发起模型调用；
 * - 会话由 SessionStore 持久化到 .sessions/<id>.json，重启后 /use 回去能续聊；
 * - 历史按会话隔离（.sessions/<id>.json），记忆是跨会话的用户档案：
 *   固定为 memory/cli.md，/use、/new 只换历史，不换记忆文件；
 * - 默认会话 id 为 cli，保持既有的 memory/cli.md 兼容；
 * - 用量（token 累计与预算）是进程级全局的，不按会话拆账。
 *
 * 内置命令：/help /sessions /new /use /del /reset /trace /verbose /exit
 */

import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';
import path from 'node:path';
import process from 'node:process';

import { loadEnv } from './env.js';
import { classifyModelError } from './errors.js';
import { AgentLoop, summarize } from './loop.js';
import { MemoryStore } from './memory.js';
import type { EnvConfig } from './model.js';
import { ENV_KEYS, createClientFromEnv, readEnvConfig } from './model.js';
import { SessionStore } from './session.js';
import { createDefaultRegistry } from './tools/index.js';
import { MarkdownSink, DEFAULT_TRACE_DIR } from './trace.js';
import { UsageTracker, readBudgetTokens, resolveUsageFile } from './usage.js';
import type { LoopResult, TraceEntry } from './types.js';

/** 默认会话 id：与既有记忆文件 memory/cli.md 保持一致 */
const DEFAULT_CLI_SESSION = 'cli';

/** SIGINT 时也要能打印用量汇总 */
let activeUsage: UsageTracker | undefined;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/** 把错误翻译成一句中文建议（不打印堆栈） */
function suggestionFor(error: unknown): string {
  const classification = classifyModelError(error);
  switch (classification.kind) {
    case 'quota':
      return '额度可能已用尽：请检查账户余额，或更换 LLM_API_KEY。';
    case 'retryable':
      return '可能是临时网络或上游问题：稍后重试，并检查 LLM_BASE_URL 是否可达。';
    case 'bad_request':
      return '请求或凭据可能不合法：检查 .env 里的 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL。';
    default:
      return '可以换个说法、/reset 清空历史后重试，或检查工具参数。';
  }
}

/** 用户可见错误：一行原因 + 一行建议；堆栈只在 DEBUG=1 时输出 */
function printUserFacingError(context: string, error: unknown): void {
  console.error(`${context}：${errorMessage(error)}`);
  console.error(`建议：${suggestionFor(error)}`);
  if (process.env['DEBUG'] === '1' && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
}

/** 缺 key 时的完整说明：默认只印一行，详细说明放在 /help 与 --verbose 里 */
function missingKeyLines(): string[] {
  return [
    '未检测到环境变量 LLM_API_KEY，暂时无法调用模型。',
    '请先设置模型凭据（任意 OpenAI-compatible 服务）：',
    `  ${ENV_KEYS.baseUrl}   服务根地址，例如 https://api.openai.com/v1`,
    `  ${ENV_KEYS.apiKey}    模型服务的 API Key`,
    `  ${ENV_KEYS.model}     模型名，例如 gpt-4o-mini`,
    'PowerShell 示例：',
    '  $env:LLM_BASE_URL="https://api.openai.com/v1";',
    '  $env:LLM_API_KEY="<你的 key>";',
    '  $env:LLM_MODEL="gpt-4o-mini";',
    '  npm start',
    '也可以把上述变量写进 .env（已被 .gitignore 忽略）。',
    '会话管理命令（/sessions /new /use /del /reset /help）在没有 key 时仍然可用。',
  ];
}

function printMissingKeyHint(): void {
  for (const line of missingKeyLines()) console.log(line);
}

/** trace 摘要：一行一条，便于观察 agent 行为（仅详细模式打印） */
function formatTraceEntry(entry: TraceEntry): string {
  const head = `#${entry.turn} ${entry.kind.padEnd(5)}`;
  const time = `${entry.durationMs}ms`;
  const usage = entry.usage
    ? ` usage=${entry.usage.totalTokens ?? '-'}(p${entry.usage.promptTokens ?? '-'}/c${entry.usage.completionTokens ?? '-'})`
    : '';

  if (entry.kind === 'tool') {
    const status = entry.ok ? 'ok' : 'fail';
    return `${head} ${entry.toolName}(${entry.args ?? ''}) -> ${status} ${entry.resultSummary ?? ''} [${time}]`;
  }
  if (entry.kind === 'model') {
    return `${head} ${entry.ok ? 'ok' : 'fail'} ${entry.resultSummary ?? ''} [${time}]${usage}${
      entry.note ? ` ${entry.note}` : ''
    }`;
  }
  return `${head} ${entry.note ?? ''} ${entry.resultSummary ?? ''} [${time}]`;
}

function printTrace(entries: TraceEntry[]): void {
  if (entries.length === 0) {
    console.log('[trace] 暂无记录');
    return;
  }
  console.log('[trace]');
  for (const entry of entries) console.log(`  ${formatTraceEntry(entry)}`);
}

/** 一轮对话结束后的 trace 明细：只有详细模式才会调用 */
function printVerboseTurn(
  sessionId: string,
  result: LoopResult,
  tracePath: string | undefined,
  usage: UsageTracker,
): void {
  const toolEntries = result.trace.filter((entry) => entry.kind === 'tool');
  const totalMs = result.trace.reduce((sum, entry) => sum + entry.durationMs, 0);
  console.log(
    `[trace] session=${sessionId} turns=${result.turns} stop=${result.stopReason} tools=${toolEntries.length} total=${totalMs}ms`,
  );
  for (const entry of result.trace) console.log(`  ${formatTraceEntry(entry)}`);
  if (tracePath) console.log(`[trace] 落盘：${tracePath}`);
  console.log(`[usage] ${usage.summary()}`);
}

/** 本地时间 'YYYY-MM-DD HH:mm'，与记忆文件的时间戳口径一致 */
function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 行读取器：同时兼容交互终端与管道/重定向输入。
 * 直接用 rl.question 时，管道里的多行会在一次 data 事件里全部读完，
 * 只有第一行能拿到（其余被丢弃），所以先把 'line' 事件缓存进队列再按需取。
 */
class LineReader {
  private readonly lines: string[] = [];
  private waiting: ((line: string | null) => void) | undefined;
  private closed = false;
  private readonly terminal: boolean;

  constructor(private readonly rl: Interface) {
    this.terminal = Boolean(process.stdin.isTTY);
    rl.on('line', (line: string) => {
      const waiter = this.waiting;
      if (waiter) {
        this.waiting = undefined;
        waiter(line);
        return;
      }
      this.lines.push(line);
    });
    rl.on('close', () => {
      this.closed = true;
      const waiter = this.waiting;
      if (waiter) {
        this.waiting = undefined;
        waiter(null);
      }
    });
  }

  /** 取一行：先吃队列，再等下一次 'line'；输入结束（EOF）返回 null */
  private async takeLine(): Promise<string | null> {
    const buffered = this.lines.shift();
    if (buffered !== undefined) return buffered;
    if (this.closed) return null;
    return new Promise<string | null>((resolve) => {
      this.waiting = resolve;
    });
  }

  /** 打印提示符并取下一行；输入结束（EOF）返回 null */
  async next(prompt: string): Promise<string | null> {
    if (this.terminal) {
      this.rl.setPrompt(prompt);
      this.rl.prompt();
      return this.takeLine();
    }
    // 非终端：提示符与输入一起打印，保证管道输出里顺序可读
    const line = await this.takeLine();
    process.stdout.write(line === null ? prompt : `${prompt}${line}\n`);
    return line;
  }
}

/** 列出会话：id、消息条数、更新时间，当前会话打 * */
async function printSessions(store: SessionStore, currentId: string): Promise<void> {
  const list = await store.list();
  console.log(`[sessions] 目录：${store.dir}`);
  if (list.length === 0) {
    console.log('  暂无持久化会话（发送第一条消息或 /new 会自动创建）');
    return;
  }
  for (const item of list) {
    const mark = item.id === currentId ? '*' : ' ';
    const current = item.id === currentId ? '（当前）' : '';
    console.log(
      `  ${mark} ${item.id}  消息 ${item.messageCount} 条  更新于 ${formatTime(item.updatedAt)}${current}`,
    );
  }
}

interface HelpContext {
  sessionId: string;
  sessions: SessionStore;
  memory: MemoryStore;
  config: EnvConfig | null;
  budgetTokens: number | undefined;
  usageFile: string | undefined;
  verbose: boolean;
}

/** /help：命令清单 + 环境信息（banner 里不再打印的长信息都在这里） */
function printHelp(context: HelpContext): void {
  const { sessionId, sessions, memory, config, budgetTokens, usageFile, verbose } = context;

  console.log('命令：');
  console.log('  /help            显示本帮助（命令清单与环境信息）');
  console.log('  /sessions        列出会话（id、消息条数、更新时间，* 为当前会话）');
  console.log('  /new [id]        新建会话并切换；不给 id 时自动生成');
  console.log('  /use <id>        切换会话（只换消息历史；记忆全局共享，不随会话切换）');
  console.log('  /del <id>        删除会话（先打印 id 与消息条数，输入 y 才真删）');
  console.log('  /reset           清空当前会话历史并落盘（不删记忆）');
  console.log('  /trace           打印上一轮完整 trace 与落盘路径（.trace/<runId>/trace.markdown）');
  console.log(`  /verbose [on|off] 切换详细输出（trace 明细 / usage 汇总 / 落盘路径），当前：${verbose ? '开' : '关'}`);
  console.log('  /exit            退出（/quit 同义）');

  console.log('');
  console.log('当前环境：');
  console.log(`  会话：${sessionId}`);
  console.log(`  会话目录：${sessions.dir}（${sessionId}.json）`);
  console.log(`  记忆文件：${memory.filePath}（全局长期记忆，跨会话共享，/reset 不会删除）`);
  if (config) {
    console.log(`  模型：${config.model}`);
    console.log(`  地址：${config.baseUrl}`);
  } else {
    console.log('  模型：未配置（LLM_API_KEY 缺失，只能执行会话管理命令）');
  }
  if (budgetTokens !== undefined) {
    console.log(`  预算：${budgetTokens} tokens（AGENT_BUDGET_TOKENS，跨会话共享）`);
  } else {
    console.log('  预算：未限制（可用 AGENT_BUDGET_TOKENS 设上限）');
  }
  console.log(`  用量落盘：${usageFile ?? '未开启（--usage 或 AGENT_USAGE_FILE 开启）'}`);
  console.log(`  trace 目录：${path.resolve(process.cwd(), DEFAULT_TRACE_DIR)}（每次输入一份 <runId>/trace.markdown）`);
  console.log(`  详细模式：${verbose ? '开' : '关'}（--verbose 或 /verbose 切换）`);

  console.log('');
  console.log('启动参数：');
  console.log('  --usage      把用量写入 .agent-usage.json（与 --verbose 互不影响）');
  console.log('  --verbose    打印 trace 明细、usage 汇总与 trace 落盘路径');
  console.log('环境变量：AGENT_USAGE_FILE / AGENT_BUDGET_TOKENS / AGENT_MAX_TURNS');

  if (!config) {
    console.log('');
    for (const line of missingKeyLines()) console.log(line);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // 详细模式：启动参数 --verbose 打开，运行时可用 /verbose 切换；与 --usage 互不影响
  let verbose = argv.includes('--verbose');

  // .env 先于模型配置读：真实环境变量优先，文件里的键只补缺；缺失/失败都静默
  const envLoad = await loadEnv();
  if (verbose && envLoad.path !== null) {
    console.log(`已加载 .env（${envLoad.loaded.length} 项环境变量）`);
  }

  // 会话存储先就绪：即使没有模型 key，/sessions /new /use /del 也要能跑
  const sessions = new SessionStore();
  let sessionId = sessions.resolveId(DEFAULT_CLI_SESSION);
  // 记忆全局共享：进程内只有一个实例、固定 memory/cli.md，不随会话切换
  const memory = new MemoryStore();

  const config = readEnvConfig();
  const usageFile = resolveUsageFile({ enabled: argv.includes('--usage') });
  const budgetTokens = readBudgetTokens();
  const usage = new UsageTracker({ filePath: usageFile, budgetTokens });
  activeUsage = usage;

  let loop: AgentLoop | undefined;
  if (!config) {
    // 缺 key 时默认只留一行提示（见下方 banner）；完整凭据说明放在 /help 与 --verbose 里
    process.exitCode = 1;
  } else {
    try {
      loop = new AgentLoop({
        model: createClientFromEnv(),
        modelName: config.model,
        registry: createDefaultRegistry(),
        maxTurns: Number(process.env['AGENT_MAX_TURNS']) || undefined,
        sessionId,
        // 会话持久化按 sessionId 隔离；memory 是全局单实例，跨会话共享
        sessions,
        memory: memory,
        usage,
      });
    } catch (error) {
      printUserFacingError('初始化失败', error);
      process.exitCode = 1;
    }
  }

  // 启动 banner：默认 1~2 行；详细模式才展开目录、预算与命令清单（其余细节见 /help）
  if (config) {
    console.log(`mini-agent 已启动 · 会话 ${sessionId} · 模型 ${config.model}`);
  } else {
    console.log(`mini-agent 已启动 · 会话 ${sessionId} · 模型未配置（LLM_API_KEY 缺失）`);
  }
  if (verbose) {
    console.log(`  会话目录：${sessions.dir}（${sessionId}.json）`);
    console.log(`  记忆文件：${memory.filePath}（全局长期记忆，跨会话共享，/reset 不会删除）`);
    if (config) console.log(`  地址：${config.baseUrl}`);
    if (budgetTokens !== undefined) console.log(`  预算：${budgetTokens} tokens（AGENT_BUDGET_TOKENS，跨会话共享）`);
    if (usageFile) console.log(`  用量落盘：${usageFile}`);
    console.log(`  trace 目录：${path.resolve(process.cwd(), DEFAULT_TRACE_DIR)}（每次输入一份 <runId>/trace.markdown）`);
    console.log('  命令：/help /sessions /new /use /del /reset /trace /verbose /exit');
    if (!config) printMissingKeyHint();
    console.log('');
  } else {
    console.log('输入 /help 查看命令与环境信息；/verbose 打开详细输出\n');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const reader = new LineReader(rl);
  let lastTrace: TraceEntry[] = [];
  /** 上一次 run 的 trace 文件路径；/trace 会一并打印 */
  let lastTracePath: string | undefined;

  /** 切换会话：历史由 loop 从 SessionStore 读；记忆全局共享，不随会话切换 */
  const switchTo = (id: string): void => {
    sessionId = id;
    lastTrace = [];
    lastTracePath = undefined;
  };

  for (;;) {
    const line = await reader.next(`[${sessionId}] > `);
    if (line === null) break; // stdin 结束（Ctrl+D / 管道读完）

    const input = line.trim();
    if (input === '') continue;

    if (input === '/exit' || input === '/quit') break;

    if (input === '/help') {
      printHelp({ sessionId, sessions, memory, config, budgetTokens, usageFile, verbose });
      console.log('');
      continue;
    }

    if (input === '/verbose' || input.startsWith('/verbose ')) {
      const raw = input.slice('/verbose'.length).trim().toLowerCase();
      if (raw === 'on' || raw === 'off') verbose = raw === 'on';
      else if (raw !== '') {
        console.log('用法：/verbose [on|off]；不给参数时切换开关\n');
        continue;
      } else verbose = !verbose;
      console.log(`详细模式：${verbose ? '已开启' : '已关闭'}${verbose ? '（trace 明细 / usage 汇总 / 落盘路径）' : ''}\n`);
      continue;
    }

    if (input === '/sessions') {
      await printSessions(sessions, sessionId);
      console.log('');
      continue;
    }

    if (input === '/new' || input.startsWith('/new ')) {
      const raw = input.slice('/new'.length).trim();
      const target = sessions.resolveId(raw);
      if (await sessions.exists(target)) {
        console.log(`会话 ${target} 已存在，用 /use ${target} 切换\n`);
        continue;
      }
      await sessions.create(target);
      switchTo(target);
      console.log(`已新建并切换到会话 ${target}（只换历史）`);
      console.log(`  记忆文件：${memory.filePath}（全局共享，未变）\n`);
      continue;
    }

    if (input === '/use' || input.startsWith('/use ')) {
      const raw = input.slice('/use'.length).trim();
      if (raw === '') {
        console.log('用法：/use <id>；可用 /sessions 查看已有会话\n');
        continue;
      }
      const target = sessions.resolveId(raw);
      if (!(await sessions.exists(target))) {
        console.log(`会话 ${target} 不存在；可用 /sessions 查看，或 /new ${target} 新建\n`);
        continue;
      }
      switchTo(target);
      const state = await sessions.load(target);
      console.log(`已切换到会话 ${target}（${state.messages.length} 条历史消息）`);
      console.log(`  记忆文件：${memory.filePath}（全局共享，未变）\n`);
      continue;
    }

    if (input === '/del' || input.startsWith('/del ')) {
      const raw = input.slice('/del'.length).trim();
      if (raw === '') {
        console.log('用法：/del <id>；删除前会要求确认\n');
        continue;
      }
      const target = sessions.resolveId(raw);
      if (!(await sessions.exists(target))) {
        console.log(`会话 ${target} 不存在；可用 /sessions 查看\n`);
        continue;
      }
      const state = await sessions.load(target);
      console.log(`即将删除会话 ${target}：${state.messages.length} 条历史消息`);
      console.log(`  记忆文件 ${memory.filePath} 是全局共享的，不会被删除`);
      const reply = await reader.next('确认删除请输入 y，其它任意输入取消：');
      if (reply === null) break;
      if (reply.trim().toLowerCase() !== 'y') {
        console.log('已取消，未删除\n');
        continue;
      }
      await sessions.delete(target);
      console.log(`已删除会话 ${target}`);
      if (target === sessionId) {
        switchTo(sessions.resolveId(DEFAULT_CLI_SESSION));
        console.log(`当前会话回到 ${sessionId}\n`);
      } else {
        console.log('');
      }
      continue;
    }

    if (input === '/reset') {
      await sessions.save(sessionId, []);
      lastTrace = [];
      lastTracePath = undefined;
      console.log(`会话 ${sessionId} 的对话历史已清空并落盘（记忆文件保留）\n`);
      continue;
    }

    if (input === '/trace') {
      // 显式调用不受详细模式影响：照旧打印上一轮完整 trace 与落盘路径
      printTrace(lastTrace);
      if (lastTracePath) console.log(`  落盘：${lastTracePath}`);
      else console.log('  落盘：暂无（还没发起过对话）');
      console.log('');
      continue;
    }

    if (!loop) {
      console.log('未配置 LLM_API_KEY，无法对话；可用 /sessions /new /use /del /reset 管理会话。\n');
      continue;
    }

    try {
      // 每次用户输入触发一次 run：一份独立的 trace 文件（.trace/<runId>/trace.markdown）
      const sink = new MarkdownSink({
        onError: (error) => {
          console.error(`[trace] 落盘失败（已降级，不影响对话）：${errorMessage(error)}`);
        },
      });
      const result = await loop.run(input, { sessionId, traceSink: sink });
      lastTrace = result.trace;
      lastTracePath = sink.filePath;
      // 默认只打印回答；trace 明细 / usage 汇总 / 落盘路径只在详细模式出现
      console.log(`\n${result.answer || '（模型返回了空回复）'}\n`);
      if (verbose) {
        printVerboseTurn(sessionId, result, sink.filePath, usage);
        console.log('');
      }
    } catch (error) {
      // 兜底：正常情况下 loop 不会抛异常，这里防止 REPL 直接崩掉
      printUserFacingError('执行出错', error);
      console.error(`（trace 摘要：${summarize(errorMessage(error), 120)}）\n`);
    }
  }

  rl.close();
}

process.on('SIGINT', () => {
  console.log('\n已退出');
  if (activeUsage) console.log(activeUsage.summary());
  process.exit(0);
});

main().catch((error: unknown) => {
  printUserFacingError('启动失败', error);
  process.exitCode = 1;
});
