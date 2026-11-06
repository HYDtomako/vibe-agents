# mini-agent

一个从零实现的最小可用 Agent Runtime 骨架：**agent loop + 模型适配 + 工具注册 + 上下文压缩 + 记忆 + 多 session 隔离 + trace + 测试**。

核心约束：不依赖任何 agent / LLM 框架（langgraph、openhands、openclaw 等），不使用 openai 官方 SDK，
模型调用直接用 Node 内置 `fetch` 打 OpenAI-compatible 的 `/chat/completions`。
运行时依赖为零，`devDependencies` 只有 `typescript` / `@types/node` / `tsx`。

---

## 快速开始

要求 Node 22+（开发环境为 Node 24），npm 11。

```bash
npm install          # 只装 3 个开发依赖，无运行时依赖
npm run build        # tsc 编译到 dist/
npm test             # node:test 全部用例，不联网、不需要真实 key
npm start            # 启动 REPL（tsx 直跑 TS 源码）
```

### 配置模型凭据

凭据**只**从环境变量读取，代码里没有任何 key：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `LLM_BASE_URL` | 服务根地址，例如 `https://api.openai.com/v1` | `https://api.openai.com/v1` |
| `LLM_API_KEY` | 模型服务 API Key（**必需**） | 无 |
| `LLM_MODEL` | 模型名 | `gpt-4o-mini` |
| `LLM_TIMEOUT_MS` | 单次模型调用超时 | `60000` |
| `AGENT_MAX_TURNS` | 最大轮次（CLI 可选覆盖） | `8` |
| `AGENT_USAGE_FILE` | 用量落盘路径；`1` 表示 `.agent-usage.json` | 关闭 |
| `AGENT_BUDGET_TOKENS` | token 预算上限，达到后停止 | 不限制 |

PowerShell：

```powershell
$env:LLM_BASE_URL="https://api.openai.com/v1"
$env:LLM_API_KEY="<你的 key>"
$env:LLM_MODEL="gpt-4o-mini"
npm start
```

Bash：

```bash
export LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=...
npm start
```

也可以把变量写进 `.env`（`.env` 已在 `.gitignore` 中；`.env.example` 只是占位模板）。
**没有 `LLM_API_KEY` 时 CLI 会打印清晰提示并以退出码 1 退出，不会发起任何调用。**

#### `.env` 的加载时机与优先级

CLI 启动时会在**读取模型配置之前**加载当前工作目录下的 `.env`（实现见 `src/env.ts`，零依赖、无 npm 包）：

- **优先级**：真实环境变量优先。`process.env` 里已存在的键一律不覆盖，`.env` 只补缺；
  因此「临时 `export` 覆盖 `.env`」是可用做法；
- **时机**：进程启动的第一件事，所以 `.env` 里的 `LLM_*` 和 `AGENT_*`
  （`AGENT_MAX_TURNS` / `AGENT_USAGE_FILE` / `AGENT_BUDGET_TOKENS`）都会生效；
- **可见性**：加载成功只打印一行 `已加载 .env（3 项环境变量）`，给的是**数量**；
  变量值和键名都不打印，程序里没有任何回显凭据的路径；
- **静默失败**：文件不存在或读不出来时安静跳过（不打印、不报错），
  「没有 key 也能用会话管理命令」的行为不受影响；
- **解析规则**：忽略空行与 `#` 开头的注释，支持可选 `export ` 前缀，值两侧成对的 `"` / `'` 会去掉，
  兼容 CRLF 与 BOM；没有 `=` 的行、KEY 不合法的行直接忽略（不报错）；同名键后者覆盖前者。

### REPL 内置命令

```
/help        查看命令
/sessions    列出会话（id、消息条数、更新时间，* 为当前会话）
/new [id]    新建会话并切换；不给 id 时自动生成 s-<时间戳>-<随机4位>
/use <id>    切换会话（只换消息历史；记忆是全局共享的，不换文件）
/del <id>    删除会话（先打印 id 与消息条数，输入 y 才真删）
/reset       清空当前会话历史并落盘（不删记忆文件）
/trace       打印上一轮完整 trace，并给出本次 trace 文件路径（.trace/<runId>/trace.markdown）
/exit        退出
```

提示符会显示当前会话，例如 `[cli] > `、`[work] > `。

启动参数 `--usage` 会把用量写入 `.agent-usage.json`；也可以用 `AGENT_USAGE_FILE` 指定路径。
用量是**进程级全局**的（跨会话共享一个 `UsageTracker`，预算也只有一个），不按会话拆账。

REPL 会启用记忆层：记忆是**跨会话的用户档案**，固定写入 `memory/cli.md`（全局单文件，
切换会话不换文件、不按会话派生），每次模型调用前按最后一条用户消息召回并注入 `[相关记忆]`。

每次用户输入触发一次 run，CLI 会为它新建一个 `MarkdownSink`，把结构化 trace 落到
`.trace/<runId>/trace.markdown`（详见「Trace 落盘」一节）；trace 写失败只降级打日志，不影响对话。

没有 `LLM_API_KEY` 时仍可启动 REPL：会话管理命令全部可用，只是普通输入会提示未配置模型
（进程退出码为 1）。

---

## 示例

不想临场敲命令就直接抄：**[examples/README.md](examples/README.md)** 按场景给了可整段复制的片段，
每段都写清「你敲什么 → 预期看到什么 → 为什么」，覆盖工具调用（calculator / weather / 文件读写）、
记忆召回（写一条再新开会话验证）、会话管理（`/sessions` `/new` `/use` `/reset`）、
上下文压缩（怎么造出长对话触发、触发后从哪看出被压过）、以及 trace / 详细模式（默认精简，
显式 `/verbose` 或 `/trace` 才看明细）。

只想看上下文压缩的三层效果、又不想联网或花 token：

```bash
npx tsx examples/compaction-demo.ts
```

它用假 `ModelClient`（固定摘要文本）在内存里造长对话，分别演示第 1 层裁剪、第 2 层摘要、
第 3 层兜底各自的触发条件与效果，打印压缩前后的消息数 / 估算 token、命中的层级与被裁剪或摘要掉的内容。
**不联网、不需要 API key、不读 `.env`、不写 `.trace` / `.sessions`。**

---

## 目录结构

```
mini-agent/
├─ src/
│  ├─ types.ts            # Message / ToolSpec / ToolResult / TraceEntry / LoopResult 等核心类型
│  ├─ model.ts            # ModelClient 接口 + OpenAICompatibleClient（fetch、超时、错误归一化、usage 透传）
│  ├─ loop.ts             # agent loop：记忆召回 + 上下文压缩 + 四步循环、重试/熔断/配额、trace
│  ├─ errors.ts           # 错误分类：retryable / fatal / quota / bad_request
│  ├─ retry.ts            # 重试与退避：指数 + 抖动 + Retry-After + deadline
│  ├─ usage.ts            # 用量记账：token 累计、预算、可选落盘 .agent-usage.json
│  ├─ trace.ts            # trace 落盘：结构化事件 union + MarkdownSink（每条追加写 + fsync）
│  ├─ context.ts          # Context Engineering：三层压缩（降载 / 摘要 / 兜底），含 token 估算
│  ├─ memory.ts           # 记忆层：全局单文件 memory/cli.md + grep 候选 + 词面打分召回 + remember 工具
│  ├─ session.ts          # 会话持久化：<dir>/<id>.json，原子写、id 规范化、损坏文件留档
│  ├─ env.ts              # 零依赖 .env 加载器：真实环境变量优先，只补缺不覆盖，失败静默
│  ├─ cli.ts              # 最小 REPL：读 stdin、多会话切换、打印回复与 trace 摘要
│  ├─ index.ts            # 库入口，供其他程序嵌入
│  └─ tools/
│     ├─ base.ts          # 工具统一写法：Tool 接口 + defineTool 校验 + toolOk/toolFail
│     ├─ registry.ts      # 注册 / 导出 tools / 统一执行与异常兜底
│     ├─ calculator.ts    # 安全四则运算（手写词法+递归下降，禁用 eval）
│     ├─ todo.ts          # 内存待办 add/list/done
│     ├─ search.ts        # mock 固定知识库检索
│     ├─ fs-path.ts       # 沙箱路径解析：越界 / .. / 符号链接逃逸一律拒绝
│     ├─ grep-core.ts     # 目录遍历 + 逐行匹配内核（grep 工具与记忆检索共用）
│     ├─ read-file.ts     # read_file：带行号、分页、截断提示
│     ├─ grep.ts          # grep：递归搜索，默认跳过 node_modules/.git/dist/coverage
│     ├─ edit-file.ts     # edit_file：oldText 必须唯一命中
│     ├─ write-file.ts    # write_file：自动建父目录，默认不覆盖
│     ├─ weather.ts       # weather：Open-Meteo（免 key），中文摘要，fetch 可注入
│     └─ index.ts         # 默认工具集装配
├─ tests/
│  ├─ loop.test.ts        # loop 主流程、工具/模型重试、熔断、配额、用量、trace
│  ├─ errors.test.ts      # 错误分类表：各类 error/status -> ErrorKind
│  ├─ retry.test.ts       # 退避序列、Retry-After、deadline、fatal 不重试（sleep 注入）
│  ├─ usage.test.ts       # 用量累计、缺失字段按 0、预算、AGENT_USAGE_FILE 落盘
│  ├─ model.test.ts       # 协议转换、HTTP 错误、超时、环境变量配置
│  ├─ calculator.test.ts  # 表达式解析合法/非法用例
│  ├─ registry.test.ts    # 注册表兜底、todo 状态、search 命中
│  ├─ tools-base.test.ts  # defineTool 校验、registry 失败兜底、重复注册
│  ├─ tools-fs.test.ts    # 四个文件工具 + 沙箱越界（全部在 tmpdir）
│  ├─ weather.test.ts     # 假 fetch：命中/无结果/非 2xx/超时/天气码/多日预报
│  ├─ context.test.ts     # 三层压缩各自触发、配对完整、兜底不抛
│  ├─ memory.test.ts      # 写入去重/上限/格式、检索打分、loop 注入与压缩存活
│  ├─ session.test.ts     # SessionStore：读写/list/delete、id 规范化、路径穿越、损坏恢复、原子写
│  ├─ isolation.test.ts   # 多 session：消息/todo 隔离 + 记忆全局共享 + 熔断/trace 归属
│  ├─ trace.test.ts       # trace 事件字段/seq 递增、MarkdownSink 追加写与 flush、fs.write 快照
│  └─ env.test.ts         # .env 解析规则、文件缺失静默、环境变量优先（tmpdir 自建固件）
├─ examples/
│  ├─ README.md           # 示例集：可整段复制的 REPL 片段（工具/记忆/会话/压缩/trace）
│  └─ compaction-demo.ts  # 离线压缩演示：假摘要器 + 三层触发与效果（不联网、不写目录）
├─ .env.example
├─ .gitignore
├─ package.json
├─ tsconfig.json
└─ tsconfig.typecheck.json
```

运行时会生成三个本地目录（都已在 `.gitignore` 里）：`.sessions/`（会话 JSON）、`memory/`（记忆 Markdown）
与 `.trace/`（每次 run 一份 `trace.markdown` + 被写文件的快照）。

---

## Loop 执行流程

```
                 ┌──────────────────────────────┐
 user input ───▶ │ messages = [system?, history,  │
                 │             user]             │
                 └──────────────┬───────────────┘
                                ▼
                 ┌──────────────────────────────┐
                 │ 0. 记忆召回（memory 配了才跑）│
                 │    在 system 前缀后插一条     │
                 │    [相关记忆] system 消息     │
                 └──────────────┬───────────────┘
                                ▼
                 ┌──────────────────────────────┐
                 │ 0.5 context.fit（三层压缩）   │
                 │    只影响「发给模型的消息」，  │
                 │    不改 LoopResult.messages   │
                 └──────────────┬───────────────┘
                                ▼
                 ┌──────────────────────────────┐
                 │ 1. 调模型 chat(messages,     │
                 │    tools = registry.list())  │
                 └──────────────┬───────────────┘
                                ▼
                     ┌────────────────────┐
                     │ 有 tool_calls 吗？ │
                     └─────┬────────┬─────┘
                       没有│        │有
                           ▼        ▼
                 ┌──────────────┐  ┌──────────────────────────────┐
                 │ 直接返回答案 │  │ 2. 串行执行每个工具：         │
                 │ stopReason=  │  │    registry.run(name,args)   │
                 │   final      │  │    -> { ok, output }（不抛）  │
                 │ + 自动记忆   │  └──────────────┬───────────────┘
                 └──────────────┘                 ▼
                                   ┌──────────────────────────────┐
                                   │ 3. 结果回灌为 role=tool 消息  │
                                   │ 4. turn++，回到第 0 步        │
                                   └──────────────┬───────────────┘
                                                  │ turn > maxTurns
                                                  ▼
                                   ┌──────────────────────────────┐
                                   │ 明确终止：stopReason=         │
                                   │   max_turns + 最后结果摘要    │
                                   └──────────────────────────────┘
```

要点：

- **会话续聊**：配了 `AgentLoopOptions.sessions` 时，`history` 从 `.sessions/<id>.json` 读，
  run 结束后把结果（去掉 system）写回；不配则完全走原来的「上层传 history」模式。
- **纯对话一轮返回**：模型没有 `tool_calls` 时立即结束，不浪费轮次。
- **maxTurns 上限**（默认 8）：超限返回 `stopReason: 'max_turns'`，答案里写明 `maxTurns=N` 并附最后几轮工具结果。
- **异常隔离**（loop 永不抛异常给调用方）：

| 故障 | 处理方式 | 结果 |
| --- | --- | --- |
| 模型调用 429 / 5xx / 网络 / 超时 | 退避重试（最多 3 次，尊重 Retry-After） | 成功则继续；耗尽 `stopReason: 'retry_exhausted'` |
| 模型调用 400/401/403/404/413/422 | 不重试 | `stopReason: 'model_error'`，答案含原因与检查建议 |
| 模型调用 402 / insufficient_quota / billing | 不重试 | `stopReason: 'quota_exhausted'`，中文额度提示 |
| 工具 handler 抛异常（含异步 reject） | registry 捕获；可重试错误由 loop 重试 | 重试耗尽后 `TOOL_RETRY_EXHAUSTED` 回执交回模型 |
| 同一工具同一 session 连续失败 ≥ 3 次 | loop 熔断 | `stopReason: 'tool_failure'`，中文失败报告 |
| 累计 token 达到 `AGENT_BUDGET_TOKENS` | 下一次调模型前停止 | `stopReason: 'quota_exhausted'`，给出累计量与上限 |
| 模型返回非法 JSON 参数 | registry 捕获 | `{ ok: false, error: 'INVALID_ARGUMENTS_JSON' }` 回灌 |
| 未知工具名 | registry 捕获 | `{ ok: false, error: 'UNKNOWN_TOOL' }` 含可用工具列表 |
| 上下文压缩 / 摘要器失败 | `context.ts` 内部兜底 | 降级到硬摘要或原始消息，loop 照常跑 |
| 记忆检索 / 写入失败 | loop 内 try/catch | 不影响本次对话，`memory_hits=0` |
| logger 自己抛错 | loop 内 try/catch | 不影响主流程 |

- **trace**：每次模型调用 / 每次工具执行 / 最终结果各一条，字段为
  `{ turn, kind, sessionId?, toolName?, args?, resultSummary?, ok?, durationMs, usage?, note? }`。
  `kind=model` 的 `note` 会带上当轮压缩情况，例如
  `context: layer1=0 layer2=56 layer3=0 chars 8421->1203 tokens≈412（layer2 生效：…）；memory_hits=2`。
  既可注入 `logger` 实时消费，也始终累积在 `LoopResult.trace` 中（结果摘要截断到 200 字符，避免膨胀）。

### 工具调用协议

工具结果以结构化文本回灌，模型能直接判断成败：

```json
{"ok": false, "output": "工具 calculator 执行失败：除数不能为 0", "error": "除数不能为 0"}
```

---

## 异常处理与额度

异常处理按「分类 → 重试 → 兜底 → 回退给用户」四步走，分类逻辑集中在 `src/errors.ts`，
退避逻辑集中在 `src/retry.ts`，额度记账集中在 `src/usage.ts`。

### 错误分类

`classifyToolError(result)` 与 `classifyModelError(error)` 都返回
`{ kind, reason, status?, retryAfterMs? }`，其中 `kind` 只有四种：

| ErrorKind | 典型信号 | 处理策略 |
| --- | --- | --- |
| `retryable` | `ETIMEDOUT` / `AbortError` / `ECONNRESET` / `ENOTFOUND` / `EAI_AGAIN`、网络错、`429` / `RATE_LIMIT`、上游 5xx、工具声明 `retryable: true` | 指数退避重试，最多 3 次 |
| `fatal` | `INVALID_ARGUMENTS_*`、`UNKNOWN_TOOL`、schema/参数校验失败、路径越界、`edit_file` 唯一性冲突、工具声明 `retryable: false`、未识别错误 | 不重试，原样回灌 |
| `quota` | `insufficient_quota`、`billing_hard_limit_reached`、`quota`、`402`、`401/403` 且消息含 key/额度 | 立即停止，`stopReason: 'quota_exhausted'` |
| `bad_request` | 模型侧 `400/401/403/404/413/422`、未知模型错误 | 不重试，`stopReason: 'model_error'` |

工具可以在 `ToolResult` 里显式写 `retryable?: boolean`：`weather` 的网络/上游失败标 `true`，
参数类失败标 `false`；显式声明优先于文本推断。`search` 是本地 mock，参数类失败标 `false`。

### 重试策略

```ts
withRetry(fn, {
  maxAttempts: 3,       // 总尝试次数（含首次）
  baseDelayMs: 300,     // 指数退避基数
  maxDelayMs: 4000,     // 单次等待上限
  jitter: true,         // 50%-100% 抖动
  shouldRetry,          // 由错误分类决定
  deadlineMs,           // 可选：从第一次尝试开始的总耗时预算
  sleep,                // 可注入，测试不真等
  onAttempt,            // (attempt, error, delayMs) -> 写 trace
});
```

- 退避序列：`300 → 600 → 1200 → …`，封顶 `maxDelayMs`；
- **Retry-After 优先**：服务端给了 `Retry-After`（秒数或 HTTP 日期）就用它，但仍封顶 `maxDelayMs`；
- 429 的等待建议会写进 trace：`Retry-After=1500ms（实际等待 1500ms）`；
- `fatal` / `bad_request` / `quota` 一次都不重试；`retryable` 可以用 `deadlineMs` 提前放弃；
- 每次失败（含最后一次不再重试）都回调 `onAttempt`，loop 用它写 `kind=tool` / `kind=model` 的失败 trace，
  note 里带 `attempt n/m`、分类与等待时长。

### 三层兜底

1. **工具失败 → 回执交回模型换策略**：可重试错误耗尽后，loop 不再把裸错抛给用户，而是回灌一条
   `TOOL_RETRY_EXHAUSTED` 回执，写明工具名、失败分类、已重试次数与建议，让模型自行换工具/换参数/直接回答。
2. **连续失败 → 熔断**：同一工具同一 session 连续失败 ≥ 3 次，直接终止 loop，
   `stopReason: 'tool_failure'`，给用户中文失败报告（哪个工具、为什么、重试几次），不含堆栈。
3. **配额/预算 → 停止**：模型侧 402 / `insufficient_quota` / billing 不重试，直接 `quota_exhausted`；
   本地累计 token 达到 `AGENT_BUDGET_TOKENS` 时，在下一次调模型前停止，同样 `quota_exhausted`。

用户可见文案示例（不含堆栈、内部路径与密钥）：

```text
API 额度不足或计费被拒绝（HTTP 402 / insufficient_quota）。本次已停止，未重试。请检查账户余额或更换 key。

调用模型失败，已重试 3 次（原因：retryable/网络或超时（ETIMEDOUT））。可以稍后重试，或检查 LLM_BASE_URL 是否可达。（最后错误：模型调用超时（60000ms））

本次已停止：累计用量 12000 tokens 已达到预算上限 12000（prompt=9000，completion=3000）。请调整 AGENT_BUDGET_TOKENS 或更换额度更充足的 key。

同一工具连续失败 3 次，已触发熔断并终止本次任务。
工具：weather
最近失败分类：retryable（网络或超时（etimedout））
重试情况：已重试 2 次
建议：检查该工具的参数或上游状态，稍后重试；也可以换个说法或换用其它工具。
```

CLI 出错时只打印一行中文原因 + 一行建议；堆栈仅在 `DEBUG=1` 时输出。
`Ctrl+C` 退出时会打印本次累计用量。

### 用量记账与预算

`UsageTracker` 累计 `promptTokens` / `completionTokens` / `totalTokens` / 调用次数 / 失败次数 / 重试次数；
上游没给 usage 或字段缺失时按 0 计，并记录 `missingUsageCalls`，汇总里会写「上游未给 usage 的调用 N 次」。

- **trace 汇总**：每次 loop 结束都追加一条 `kind='final'` 的 trace，例如
  `用量汇总：total=120（prompt=80 / completion=40），调用 3 次，失败 0 次，重试 1 次`；
- **可选落盘**：默认关闭；`npm start -- --usage` 或 `AGENT_USAGE_FILE=.agent-usage.json` 开启，
  文件内容可直接 `JSON.parse`：

```json
{
  "version": 1,
  "updatedAt": "2026-02-01T09:30:00.000Z",
  "promptTokens": 80,
  "completionTokens": 40,
  "totalTokens": 120,
  "calls": 3,
  "failures": 0,
  "retries": 1,
  "missingUsageCalls": 0,
  "overBudget": false
}
```

- **预算**：`AGENT_BUDGET_TOKENS=12000`，或代码里 `new UsageTracker({ budgetTokens: 12000 })`；
  累计 `totalTokens >= budgetTokens` 即视为超预算，下一次调模型前停止；
- 测试里的 `sleep` / `random` / `now` 全部可注入，**没有一个用例真实等待或访问网络**。

---

## 工具清单

| 工具 | 作用 | 关键参数 | 典型失败（均返回 `ok=false`，不抛） |
| --- | --- | --- | --- |
| `calculator` | 四则运算求值，不执行代码 | `expression` | 表达式为空/非法字符/括号不匹配/除零 |
| `todo` | 进程内待办 add / list / done（按 sessionId 分区） | `action`、`text`、`id` | 未知 action、缺 text、编号不存在 |
| `search` | 内置 mock 知识库检索 | `query`、`limit` | query 缺失（无命中不算失败） |
| `read_file` | 按行读取沙箱内文本文件，带行号 | `path`、`offset`、`limit` | 越界、文件不存在、是目录、二进制、offset 越界 |
| `grep` | 递归搜索文件内容，跳过依赖/产物目录 | `pattern`、`path`、`glob`、`ignoreCase`、`regex`、`maxResults` | 越界、pattern 为空、正则非法 |
| `edit_file` | 按唯一片段替换 | `path`、`oldText`、`newText` | 越界、文件不存在、oldText 出现 0 次或多次 |
| `write_file` | 写文件，自动建父目录 | `path`、`content`、`overwrite` | 越界、已存在且未开 overwrite、目标是目录 |
| `weather` | Open-Meteo 当前天气 + 1-3 天预报 | `city`、`days` | 城市未找到、上游非 2xx、超时（8s） |
| `remember` | 写一条长期记忆 | `text`、`tag`、`kind` | text 为空、未配置记忆、超条数上限 |

分页/截断都明说边界：`read_file` 默认 200 行、上限 2000 行，截断时写「已截断，共 N 行」；
`grep` 默认最多 200 条命中，截断时提示缩小 `path`/`glob` 或调高 `maxResults`。

---

## 工具统一写法

所有工具都用 `defineTool` 定义，`ToolRegistry.register(tool)` 接收的也是它：

```ts
import { defineTool, toolOk, toolFail } from './tools/base.js';

export const nowTool = defineTool({
  name: 'now',
  description: '返回当前时间（ISO 8601）',
  parameters: { type: 'object', properties: {} },
  todo: [
    '回答「现在几点」这类问题，返回服务器当前时间。',
    '第一步：读取系统时钟，格式化为 ISO 8601。',
    '边界：不做时区换算，返回的是运行环境的本地时区。',
    '失败情况：理论上不会失败；若系统时钟异常则返回 ok=false。',
  ],
  async run(_args, _ctx) {
    return toolOk(new Date().toISOString());
  },
});
```

`defineTool` 在**定义期**就做校验，属于开发期错误，直接抛：

| 校验 | 规则 |
| --- | --- |
| `name` / `description` | 必须是非空字符串 |
| `parameters` | 必须是 `type: 'object'` 的 JSON Schema |
| `todo` | 必须是非空数组，每项非空字符串，不许出现 `TODO` / `TBD` 占位符 |
| `run` | 必须是函数，返回 `Promise<ToolResult>` |

`todo` 的语义是**给 agent 做规划用的说明**：这个工具做什么、分几步、边界在哪、什么情况会失败。
它不是装饰性注释——模型看到的就是工具描述 + 这份步骤说明。

每个工具文件头注释统一四段：一句话功能 → 参数 → 返回 → 失败情况。

`ToolRegistry` 的对外约定：

- `register(tool)`：重名、缺声明、`todo` 不合法都在注册期抛错；
- `list()`：只导出 `{ name, description, parameters }`，可直接塞进模型 `tools` 数组（`todo` 不暴露给模型协议）；
- `run(name, argsJson, ctx?)`：未知工具、非法 JSON、参数不是对象、`run` 抛错**全部**折算成 `ok=false`，绝不外抛；
- `createDefaultRegistry()`：装配上面 9 个工具，名字与用法保持不变。

文件工具的沙箱根目录默认是 `process.cwd()`，可通过 `ToolContext.rootDir` 覆盖（测试就靠它指向 `os.tmpdir()`）。

---

## Context Engineering（三层压缩）

`src/context.ts` 的 `ContextEngine.fit(messages, opts)` 返回
`{ messages, stats, notes }`，其中 `stats = { layer1Trimmed, layer2Compressed, layer3Fallback, charsBefore, charsAfter, estimatedTokens }`。
loop 在**每轮调模型之前**跑一次，只把 `fit.messages` 发给模型，`LoopResult.messages` 仍是完整历史。

**轮次切分**：开头连续的 `system` 消息（含 loop 注入的 `[相关记忆]`）是「前缀」，
之后每条 `user` 消息开启新一轮；前缀三层都不会被丢弃。

### 第 1 层：只降载、不删消息（每轮都跑）

| 对象 | 默认阈值 | 处理 |
| --- | --- | --- |
| 最近 N 轮 | N = 3 | 原样保留 |
| 更老的 `role=tool` 消息 | content ≥ 1200 字符才动 | 首 600 字符 + `…[已裁剪 N 字符]` + 尾 300 字符 |
| 更老的 `assistant.toolCalls` | `arguments` > 400 字符才动 | 保留 `id` / `name`，参数截成 head 200 + `…[参数已裁剪]` |

保证 `toolCallId` 与 `name` 不动，assistant/tool 配对不会坏；已经裁过的内容不会二次裁剪。

### 第 2 层：超阈值摘要（任一命中即触发）

| 触发条件 | 默认阈值 |
| --- | --- |
| 消息数 | > 40 |
| 估算 token | > 12000 |
| 轮次（= `user` 消息数） | > 15 |

触发后：`system` + 最近 6 轮原样保留，中间段交给注入的 `ModelClient` 压成**一条** `[历史摘要]` 消息
（概括用户目标、已完成的关键动作与结果、待办、关键事实/路径/数值），这条消息不挂 `toolCalls`。
已存在的 `[历史摘要]` 会被当作中段的一部分重新压，因此**不会越压越多条**。

### 第 3 层：兜底（第 2 层失败必走，绝不抛异常）

以下任一情况判为第 2 层失败：摘要器抛错、超时（默认 15s）、返回空内容、返回内容不比原中段短。

失败后**不再调模型**，直接保留：`system` + （已有 `[历史摘要]`，没有就写一条硬摘要，
记录丢弃条数与首末消息时间）+ 最近 12 轮，其余丢弃。

此外，`fit` 之后若仍超 `MAX_TOKENS`（同一个 12000 阈值），从最老的消息起整轮丢弃，
保底 `system` + 最近 2 轮。`notes` 里会写清每层是否生效、失败原因与丢弃条数。

### token 估算口径

轻量启发式，**是估算不是计费**：

```
token ≈ ceil(ASCII 字符数 / 4) + 宽字符（中文等）字符数
每条消息再 + 4（工具调用再加 6 + 名字 + 参数）
```

它只用于触发阈值和报告节省量，与具体服务端的分词器有偏差，所以 trace 里写成 `tokens≈N`。

---

## Memory（记忆层）

### 文件格式

`<dir>/cli.md`（文件名固定为 `cli.md`），一条记忆一行：

```
- [2026-02-01 09:30] #preference #偏好 用户偏好使用 TypeScript 写后端
```

- `#kind`：`fact` / `preference` / `todo` / `decision`，总是写；
- `#tag`：可选的话题标签，给了才写；
- 记忆是**跨会话的用户档案**：全局共享单文件，不按 `sessionId` 派生，切换会话不换文件；
  文件名沿用既有默认会话名 `cli`，老数据 `memory/cli.md` 继续可读；
- 追加写入（`append`），自动建目录，同内容去重，单文件上限 2000 条（可配）；
- 目录默认 `./memory`，测试一律注入 `os.tmpdir()`，不写项目目录。

### 召回

- **时机**：每次模型调用前，用**最后一条 `user` 消息**作为 query 召回（loop 的 `prepareMessages`）；
- **范围**：扫描整个 `memory/` 目录，命中即参与打分——记忆本来就是跨会话共享的，
  目录里历史遗留的其它 `.md` 文件也不会被排除；
- **位置**：拼成一条 `system` 消息，标记 `[相关记忆]`，插在 system 前缀**之后**、对话之前，
  每条带日期（`- (2026-02-01) [#偏好] …`）；
- **条数**：默认 topK=5，低于 0.5 分丢弃；无召回就不注入；
- **存活**：它属于「前缀」，第 1/2/3 层压缩都不得丢弃它；
- **可观测**：召回条数写进 `kind=model` 的 trace note（`memory_hits=N`）。

### 写入

- `remember` 工具：模型主动记，参数 `{ text, tag?, kind? }`，返回写入路径与当前条数；
- loop 自动记：`stopReason=final` 时把「用户目标 + 最终结论」append 成一条 `kind=decision`（内容去重）。

### 为什么用词面打分

实现简单、可解释、可离线测试，且零依赖：

```
score = 命中词数 × 1.0
      + 完整短语命中 +3
      + #tag 命中 +1.5
      + 时间近因（exp(-ageDays/7)，越新越接近 1）
      - 长度惩罚（最多 0.5）
```

query 分词：英文单词小写去停用词，中文取 2-gram（并丢掉纯虚词组合）。
候选行复用 `tools/grep-core.ts` 扫 `memory/`，不重复实现遍历与匹配。

**这是词面打分的近似语义匹配，不是向量检索**：不建 embedding、不理解同义与改写，
召回质量取决于提问用词是否与记忆重合。要真正做语义召回，需要引入模型与索引——本阶段刻意不做。

---

## 多 session 隔离

一次 `run` 属于一个会话（`sessionId`），三类状态按会话隔离，记忆则是全局共享：

| 状态 | 隔离方式 | 落盘位置 |
| --- | --- | --- |
| 消息历史 | `SessionStore`，一个会话一个 JSON 文件 | `.sessions/<id>.json` |
| todo | 工具内部 `Map<sessionId, { items, nextId }>` 分区 | 进程内，重启即失 |
| 熔断计数 | `Map<'<sessionId>::<tool>', number>` | 进程内 |
| 记忆 | **全局共享**，单文件、不派生；A 写的记忆 B 也能召回 | `memory/cli.md` |

用量（`UsageTracker`）与 trace 是**跨会话共享**的，只做归属标注，不做拆账——取舍见本节末尾。

### 会话存储

`src/session.ts` 的 `SessionStore`：

```ts
const sessions = new SessionStore({ dir: '.sessions' }); // 测试注入 tmpdir
await sessions.save('work', messages);   // 原子写：先 <file>.tmp 再 rename
const state = await sessions.load('work'); // { id, messages, createdAt, updatedAt }
await sessions.list();                   // 按 updatedAt 倒序，带 messageCount
await sessions.delete('work');           // 真删文件，返回是否删掉
await sessions.create('new-id');         // 已存在则原样返回，不覆盖历史
sessions.resolveId('../etc/passwd');     // -> 'etc_passwd'（绝对/穿越路径都拼不出目录外）
```

- **id 规范化**：只允许 `[A-Za-z0-9_.-]`，其余字符换成 `_`，连续的点折成 `_`，
  首尾的点去掉，长度上限 64；规范化后一个字母数字都没有（如 `..`、空串）就自动生成
  `s-<时间戳>-<随机4位>`。因此 `../x`、`/etc/passwd`、`C:\Windows\win.ini` 都只会变成
  目录里的普通文件名。
- **原子写**：写 `<file>.tmp` 再 `rename`，中途被杀不会留下半个 JSON；
  `createdAt` 沿用首次写入，`updatedAt` 每次刷新。
- **损坏文件**：JSON 解析失败或缺少 `messages` 数组时，把文件改名成
  `<file>.corrupt-<ts>` 留档，并按空会话返回——不会抛异常打断 REPL。
- **格式宽松校验**：`messages` 里 role 非法或结构不对的条目会被丢弃，脏数据不进模型上下文。

### loop 侧的约定

- `AgentLoopOptions.sessions` 可选；配了之后 `run` 会在**没显式传 `history`** 时从
  `sessions.load(sessionId)` 取历史，结束时把 `result.messages` 去掉 `system` 写回。
  写回发生在所有终止原因上（含 `model_error` / `retry_exhausted` / `tool_failure`），
  保存失败只追加一条 `kind=error` 的 trace，不影响返回值。
- `sessionId` 优先级：`run(input, { sessionId })` > 构造参数 `sessionId` > `'default'`。
  其中 `'default'` 只在配了 `sessions` 时兜底；没配 `sessions` 时保持 undefined，
  与单会话版本的行为、trace 字段完全一致。
- `AgentLoopOptions.memory` 语义是「全局那一份记忆存储」：所有会话读写同一个实例、
  同一个 `memory/cli.md`，loop 内部不再按 `sessionId` 派生，也不做实例缓存。
- 熔断计数键是 `<sessionId>::<tool>`：A 会话把 weather 跑到熔断，不会影响 B 会话的计数。
- trace 每条都带 `sessionId`（配了 sessions 或显式给了 id 时），用量仍是全局一份。

### CLI 用法

```text
$ npm start
[cli] > /new work
已新建并切换到会话 work（只换历史）
  记忆文件：D:\mini-agent\memory\cli.md（全局共享，未变）

[work] > /sessions
[sessions] 目录：D:\mini-agent\.sessions
    cli   消息 4 条  更新于 2026-02-01 10:12
  * work  消息 0 条  更新于 2026-02-01 10:13（当前）

[work] > 帮我把发布流程整理成 todo      # 写进 .sessions/work.json + memory/cli.md
[work] > /use cli                      # 只把历史换成 cli 的，记忆仍是同一个文件
[cli]  > /del work                     # 先打印 id 与消息条数，输入 y 才真删
```

- 默认会话 id 仍是 `cli`，所以老用户的 `memory/cli.md` 继续可用；
- 启动信息里会打印当前会话、会话目录与**全局记忆文件**路径（切换会话后路径不变）；
- `/del` 必须手动输入 `y` 确认（没有 `--force`），删除会话不会动记忆文件；
- 删掉当前会话后自动回到 `cli`。

### 已知边界与取舍

- **用量全局**：一个进程只有一个 `UsageTracker` 与一份 token 预算，切会话不重置、也不分账。
  理由：预算控制的是「这次进程跑了多少钱」，按会话拆账会让「A 会话把额度用光」这种事
  在统计上不可见。要分账需要把 tracker 也做成 per-session，属于下一阶段。
- **trace 只带 sessionId**：`TraceEntry` 里只有归属标记，没有独立的会话索引；
  要按会话检索一行摘要，需要调用方自己按 `entry.sessionId` 分组。
  结构化事件已落盘到 `.trace/<runId>/trace.markdown`（见下面的 Trace 落盘），但它是**按 run 分目录**、
  不是按会话汇总的——同一个会话的多次 run 会得到多个目录。
- **todo 不落盘**：按会话分区解决了串味，但仍是进程内状态，重启就空。
- **历史写回是「覆盖」语义**：每次 run 结束用本轮完整 `result.messages`（去 system）覆盖会话文件；
  并发跑同一会话的两次 run 会互相覆盖，本项目没做并发保护。
- **记忆只有一个文件**：`memory/cli.md` 是全局的，`/del` 只删 `.sessions/<id>.json`；
  想让某段记忆消失只能手工编辑该文件（没有按会话清记忆的命令，也没有删除 API）。

---

## Trace 落盘（可观测性）

`TraceEntry` 是「一行给人看的摘要」，够 CLI 打印；但要复盘「模型到底收到/说了什么、哪个文件被改成了什么」，
需要结构化事件。`src/trace.ts` + `.trace/` 目录就是这一层。

### 目录结构

```text
.trace/
└─ <runId>/                    # 一次 run 一个目录（runId 可由调用方传入，缺省 时间+随机后缀）
   ├─ trace.markdown           # 事件流：每条事件一节（人读描述 + json 代码块）+ 末尾完整 messages
   └─ snapshots/               # 只存「被写的文件」的原内容
      ├─ 1-notes.md            # 序号-原相对路径，覆盖前的原文件
      └─ 2-src/app.ts
```

```text
$ npm start
[cli] > 帮我把 notes.md 改成新内容
...
[trace] session=cli turns=2 stop=final tools=1 total=7ms
  #1 model ok 发起 1 次工具调用：write_file [0ms] ...
  #2 final 用量汇总：total=132...
[trace] 落盘：D:\mini-agent\.trace\20261106-094512-3f2a\trace.markdown
```

`/trace` 除了照旧打印上一轮 trace 摘要，还会多打印一行这次的 trace 文件路径。

### 事件字段

所有事件都有四个公共字段：

| 字段 | 含义 |
| --- | --- |
| `seq` | 本次 run 内从 1 递增，与文件里的事件编号一致 |
| `ts` | 事件发出时刻，ISO 8601 |
| `turn` | 轮次；`run.start` 为 0，`run.end` 发的是本次 run 的最终轮次（与其 `turns` 同值） |
| `type` | 事件类型（判别式 union 的 tag） |

| `type` | 关键字段 | 用途 |
| --- | --- | --- |
| `run.start` | `input` / `model` / `sandboxRoot` / `systemPrompt`（摘要） | 这次 run 的起点 |
| `run.end` | `stopReason` / `turns` / `usage`（UsageSnapshot）/ `usageSummary` | 终点，与 `run.start` 成对 |
| `model.reply` | `content`（全文）/ `toolCalls`（参数摘要）/ `usage` / `durationMs` / `attempts` / `compressed` / `memoryHits` | 模型到底说了什么、本轮是否压缩过、记忆命中几条 |
| `tool.call` | `toolName` / `arguments`（原文）/ `toolCallId` | 一次逻辑工具调用（重试不重复发） |
| `tool.result` | `toolName` / `ok` / `durationMs` / `attempts` / `error` / `retryable` / `output`（摘要） | 工具最终结果 |
| `fs.write` | `operation`（`fs.write`/`edit`）/ `path` / `bytes` / `overwritten` / `beforeSha256` / `afterSha256` / `snapshot` / `allowed` | 文件被改成了什么样 |
| `context.compact` | `layers`（layer1/2/3）/ `charsBefore` / `charsAfter` / `estimatedTokens` / `dropped` / `notes` | 三层压缩本轮做了什么 |
| `memory.inject` | `hitCount` / `query` / `summary` | 注入了哪几条记忆 |
| `model.retry` | `attempt` / `maxAttempts` / `delayMs` / `kind` / `reason` | 为什么重试、等了多久 |
| `error` | `scope`（model/tool/session/misc）/ `kind` / `reason` / `message` | 复用 `errors.ts` 的分类结论，不自己发明分类 |

`fs.write` 由工具声明的 `ToolResult.effect` 产生：`write_file` / `edit_file` 只在**覆盖已有文件**前
调一次 `ctx.snapshot(path)`，registry 执行完工具后统一把 effect 转成事件——工具本身不 import trace，
也不知道 trace 落不落盘。

### 为什么快照只做被写的文件

全量备份沙箱既贵又没必要：复盘要回答的是「这个文件被谁改成了什么」，所以只对 `write_file`（覆盖时）与
`edit_file`（`edit_file` 只改已有文件）抓原文件快照。新建文件没有原内容，直接跳过，
事件里只留 `afterSha256`。快照是**原文件的字节级副本**，配 `beforeSha256` / `afterSha256`
可以把「写入前后」对起来，也能验证 agent 的改动是否可逆。

### 为什么不做成工具（没有 `read_trace`）

- **不进模型上下文**：trace 是给人和外部工具看的，塞回上下文只会占 token、还容易让模型把调试信息当事实；
- **不新增工具位**：多一个工具就多一份 schema 与提示预算，也给了模型「翻自己日志」这种没用又花钱的动作；
- 需要读 trace 的是开发者/评测脚本，直接读文件即可（Markdown + json 代码块，`JSON.parse` 就能拿回事件）。

### 追加写与容错

- `MarkdownSink` **只做追加写**：每条事件 `open(...,'a')` → `write` → `fsync` → `close`，
  进程在任意时刻崩掉，前面已写的事件都还在（内部用 promise 队列串行化，事件顺序 = 调用顺序）；
- 写失败一律降级：sink 记 `error` 并回调 `onError`，loop 侧还包了一层 try/catch，
  对话结果、`LoopResult.messages`、`stopReason` 都不受影响；
- run 结束时（`run.end` 之后）把本次完整 `messages` 追加到文件末尾，用于离线复现。

接入方式：`new AgentLoop({ traceSink })` 或 `loop.run(input, { traceSink })`；CLI 每读一行输入就建一个
`new MarkdownSink()`，于是每次输入对应一个 `.trace/<runId>/`。`.trace/` 已在 `.gitignore` 里。

---

## 测试与验收

```bash
npm run build      # 无类型错误
npm test           # 302 个用例全部通过（含 session.test.ts / isolation.test.ts / trace.test.ts / env.test.ts）
npx tsx --test tests/env.test.ts   # 单独跑 .env 加载器的 16 个用例（已含在上面 302 里）
npx tsx --test tests/trace.test.ts # 单独跑 trace 的 8 个用例（已含在上面 302 里）
npm run typecheck  # 额外：连 tests/ 与 examples/ 一起类型检查
npx tsx examples/compaction-demo.ts  # 离线压缩演示，不联网、不写 .trace / .sessions
```

`package.json` 的 `test` 脚本按文件逐个列出（不用 glob），共 16 个测试文件、合计 302 个用例；
其中 `env.test.ts` 的 16 个 `.env` 加载器用例、`trace.test.ts` 的 8 个 trace 落盘用例已收录进 `npm test`。

测试特点：

- 用 `ScriptedModel` 脚本化假模型驱动 loop，**不依赖网络和真实 key**；
- 模型适配层通过注入 `fetchImpl` 桩验证，覆盖 401/500、非 JSON 响应、缺 `choices`、网络异常、超时中断；
- errors 覆盖分类表：ETIMEDOUT / 429 / 5xx / 参数错 / 路径越界 / 402 / insufficient_quota / 401+key；
- retry 用 `recordingSleep` 断言退避序列、Retry-After 优先、封顶、deadline 与 fatal 只调用 1 次；
- usage 覆盖累计、缺失字段按 0、预算、`.agent-usage.json` 落盘后 JSON 可解析；
- loop 新增工具重试/失败回执/熔断、模型 429 重试/401 直接停/402 配额、预算停止等用例；
- calculator 覆盖合法表达式、除零、非法字符、`eval(...)`、`process.exit()` 等注入尝试；
- 文件工具全部在 `os.tmpdir()` 临时目录里跑，覆盖越界（`..` / 绝对路径 / 符号链接）与截断；
- weather 用假 fetch 覆盖命中、无结果、非 2xx、超时、天气码映射与多日预报；
- context 用假摘要器覆盖三层各自触发、近零开销、配对完整、连续 fit 不重复摘要、三种兜底；
- memory 用临时目录 + 假模型覆盖固定文件名 `cli.md`、去重/上限/格式/打分、整目录召回、注入与压缩存活；
- session 覆盖读写往返、list 排序、delete、create 幂等、id 规范化、`..`/绝对路径穿越防护、
  损坏 JSON 留档恢复、原子写后无 `.tmp` 残留且内容可 `JSON.parse`；
- isolation 用两个会话交替 run，覆盖消息历史互不可见、todo 分区、记忆全局共享
  （只有一份 `cli.md`，A 写的记忆在 B 能召回）、熔断计数隔离、trace 的 sessionId 归属、error 终止也落盘；
- trace 覆盖事件公共字段（seq 递增、ISO 时间、`run.start` 的 `turn=0`、`run.end` 的 `turn` 等于最终轮次、`run.start`/`run.end` 成对）、
  MarkdownSink 的追加写与「每条 flush」（写完即可读，后续写入抛错也不丢已写内容）、
  `fs.write` 的前后 sha256 与快照文件真实存在、`context.compact` 与 `memory.inject` 在真实 loop 里各发一条、
  以及「配不配 sink，messages 完全一致」（trace 不进上下文）；
- env 在 `os.tmpdir()` 下自建 `.env` 固件（不读仓库根的 `.env`），覆盖注释/空行/`export`/成对引号/
  CRLF/BOM/无等号行/非法 KEY、文件缺失静默返回、真实环境变量优先不覆盖，
  并断言返回值里只出现键名与路径、不含变量值。

安全与依赖自检：

```bash
grep -rniE "sk-[a-z0-9]{16,}|api[_-]?key\s*[:=]\s*['\"][^'\"]+" src tests --exclude-dir=node_modules   # 应无命中
grep -rniE "langchain|langgraph|openai|anthropic|openhands|openclaw" package.json src tests             # 应无命中
```

---

## 设计取舍

- **类型解耦**：内部 `Message` 与 OpenAI wire format 分离，协议转换只发生在 `model.ts`，
  换 provider 时 loop 与工具层不动。内部字段用 camelCase（`toolCalls` / `toolCallId`），
  对应协议的 snake_case（`tool_calls` / `tool_call_id`）只出现在 `model.ts` 的 wire 类型里。
- **工具永不抛异常**：所有失败折算成 `{ ok, output, error }`，错误信息作为上下文回灌给模型，
  这是 agent 能自我纠错的前提；`run()` 的返回值类型本身就不含 throw。
- **工具声明即文档**：`todo` 强制写清步骤与失败情况，缺了或写成 `TODO` 直接拒绝注册，
  避免「工具描述一句话、模型靠猜参数」。
- **calculator 不用 eval**：手写词法分析 + 递归下降（`expression → term → unary → primary`），
  天然阻断代码注入；额外限制表达式长度 500 字符与括号嵌套深度 50。
- **沙箱先字面后真实路径**：先 `path.resolve` 做字面归一化拦掉 `..`，
  再用 `realpath` 检查「最深已存在祖先」堵住符号链接逃逸；Windows 反斜杠统一归一化、比较忽略大小写。
- **压缩与 loop 解耦**：`context.ts` 不 import loop，只吃 `Message[]`、吐 `Message[]` + stats，
  因此可以单测、可以换策略；loop 只负责「调一次 fit、把结果写进 trace」。
- **压缩不破坏历史**：`LoopResult.messages` 保留原始全量消息，压缩只作用于「发给模型的那一份」，
  续聊与调试都拿得到真实历史。
- **记忆用 Markdown**：可 grep、可人读、可 diff，不需要数据库；代价是打分只能做词面近似。
- **会话用 JSON 文件**：一个会话一个 `<id>.json`，人可读、可手工备份、原子写；代价是没有并发控制，
  也没有索引（`list()` 就是遍历目录）。
- **trace 是一等公民**：结构固定、可注入、可累积，后续评估成本与定位问题都基于它；
  两层结构（`TraceEntry` 一行摘要 + `.trace/` 结构化事件）各服务 CLI 打印与事后复盘，互不干扰。
- **零运行时依赖**：只用 Node 标准库（`fetch`、`AbortController`、`node:fs/promises`、`node:readline/promises`、`node:test`），
  避免供应链依赖，也满足题目「核心 runtime 自行实现」的要求。

---

## 下一步待做（本阶段刻意不实现，但接口已预留）

1. **会话并发与用量拆账**
   - 同一会话并发 run 目前会互相覆盖历史，需要写锁或版本号（`updatedAt` 已有，可做乐观锁）；
   - 用量仍是全局一份，若要按会话统计成本，需要 per-session 的 `UsageTracker` 与汇总口径。
2. **语义记忆召回**
   - 当前是词面打分，同义词与改写召回不了；
   - 待做：可插拔的 embedding + 向量索引，保留现有词面打分作为兜底与对照。
3. **压缩质量**
   - 摘要提示词还可以补「保留原文引用片段」；摘要器目前无法中断底层请求（只做超时放弃）；
   - 待做：把 `AbortSignal` 贯穿到 `ModelClient`，让超时真正终止上游请求。
4. **其它**
   - 流式输出（SSE）、并行工具调用（当前串行以保证顺序）、结构化 JSON Schema 校验（当前由 handler 自行校验）。
