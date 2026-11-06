# 示例集：可整段复制的运行片段

不想临场敲命令时的速查页。每个场景都是「你敲什么 → 预期看到什么 → 为什么」，
命令与提示符都按真实 REPL 输出写成，可以整段复制。

约定：

- 所有命令都在项目根目录（本机为 `D:\mini-agent`）执行；完整说明见根 [README](../README.md)；
- `[cli] > ` 是 REPL 提示符，方括号里是当前会话 id；
- **默认输出只有模型回答**；trace 明细、usage 汇总、trace 落盘路径要显式 `/verbose` 或 `/trace` 才看；
- 含 `…` 的地方随模型、网络、耗时变化，其余是稳定输出；
- 每次输入都会写 `.sessions/<id>.json` 与 `.trace/<runId>/trace.markdown`，两者都已被 `.gitignore` 忽略。

---

## 0. 三条命令热身

```bash
npm install
npm test        # 302 个用例，全部离线，不需要 key
npm start       # 起 REPL
```

预期（默认启动只有两行 banner）：

```text
mini-agent 已启动 · 会话 cli · 模型 gpt-4o-mini
输入 /help 查看命令与环境信息；/verbose 打开详细输出

[cli] > 
```

为什么：目录、记忆文件路径、命令清单、凭据说明都收进 `/help` 了，banner 不刷屏。
没有 `LLM_API_KEY` 时第一行变成「模型未配置（LLM_API_KEY 缺失）」，进程退出码为 1，
但 `/sessions /new /use /del /reset /help /exit` 仍然可用。

---

## 1. 工具调用：算数、天气、文件读写

### 1.1 calculator 计算

```text
[cli] > 用 calculator 算一下 (12+3)*4/2，只回数字
30
```

预期：只打印 `30`（有的模型会写成「结果是 30」）。

为什么：模型先发一次 `tool_call`，registry 执行 `calculator`，结果回灌后再调一次模型作答，
所以这一轮其实是 `turns=2`。calculator 是手写词法 + 递归下降，不执行代码。

想看工具真的被调用，先开详细模式：

```text
[cli] > /verbose
详细模式：已开启（trace 明细 / usage 汇总 / 落盘路径）

[cli] > 用 calculator 算一下 (12+3)*4/2，只回数字
30

[trace] session=cli turns=2 stop=final tools=1 total=…ms
  #1 model ok 发起 1 次工具调用：calculator [ …ms] usage=…(p…/c…)
  #2 tool  calculator({"expression":"(12+3)*4/2"}) -> ok (12+3)*4/2 = 30 [0ms]
  #3 model ok 30 [ …ms] usage=…(p…/c…)
  #4 final … [0ms]
[trace] 落盘：D:\mini-agent\.trace\<runId>\trace.markdown
[usage] total=…（prompt=… / completion=…），调用 2 次，失败 0 次，重试 0 次
```

### 1.2 weather 查天气

```text
[cli] > 北京现在天气怎么样？顺便看看明天要不要带伞
```

预期：一段中文摘要，形如「北京（中国）… 天气：多云 … 温度：…°C（体感 …）… 湿度：…% …」，
带 `days=2` 时还会附每日最高/最低与降水概率。

为什么：`weather` 走 Open-Meteo（免 key）先地理编码再查天气，**需要外网**。
断网或超过 8 秒会返回 `ok=false`，模型据此说明查询失败，不会编造气温。

### 1.3 文件读写：write_file / read_file / edit_file / grep

写新文件（自动建父目录，默认不覆盖已有文件）：

```text
[cli] > 在 tmp/notes.md 写一份三行待办：看 loop.ts、跑 npm test、整理文档
```

预期：模型回一句写好了；详细模式下能看到：

```text
  #2 tool  write_file({"path":"tmp/notes.md","content":"- 看 loop.ts\n- 跑 npm test\n- 整理文档"}) -> ok 已写入 tmp/notes.md：… 字节 / 3 行（新建文件）
```

读 + 局部改（`oldText` 必须唯一命中，命中 0 次或多次都会 `ok=false` 并说明原因）：

```text
[cli] > 读一下 tmp/notes.md，把第二行改成「跑 npm test && npm run typecheck」
```

搜索（默认跳过 `node_modules` / `.git` / `dist` / `coverage`）：

```text
[cli] > 用 grep 在 src 里搜 prepareMessages 出现在哪个文件
```

预期：命中行形如 `src/loop.ts:299: private async prepareMessages(...)`，末尾附「匹配 N 处，涉及 M 个文件」。

为什么：文件工具的沙箱根目录是**启动目录**（`D:\mini-agent`），只能读写项目内路径，
`..`、绝对路径越界、符号链接逃逸都会被拒绝。演示完记得清掉临时文件：

```bash
rm -rf tmp                      # Git Bash / WSL
```

```powershell
Remove-Item -Recurse -Force tmp  # PowerShell
```

---

## 2. 记忆召回：写一条，新开会话验证

### 2.1 记一条

方式 A：让模型记（写进 `memory/cli.md`，详细模式能看到 `remember` 的 tool 行）：

```text
[cli] > 记住：部署必须走 staging 环境，生产发布只在周四进行
```

方式 B：手工追加一行（不花 token，演示最稳；文件格式必须一致）：

```powershell
Add-Content -Encoding utf8 memory/cli.md '- [2026-11-06 12:00] #preference #部署 部署必须走 staging 环境，生产发布只在周四进行'
```

```bash
printf '%s\n' '- [2026-11-06 12:00] #preference #部署 部署必须走 staging 环境，生产发布只在周四进行' >> memory/cli.md
```

预期：`memory/cli.md` 末尾多一行。时间改成当天效果更好（召回有「越新越接近满分」的近因加分）。

为什么：一行一条，格式是 `- [YYYY-MM-DD HH:mm] #kind #tag 内容`，
`kind` 只能是 `fact` / `preference` / `todo` / `decision`；`#tag` 可选。
不符合这个格式的行会被解析器忽略。

### 2.2 新开会话验证召回

```text
[cli] > /new recall-check
已新建并切换到会话 recall-check（只换历史）
  记忆文件：D:\mini-agent\memory\cli.md（全局共享，未变）

[recall-check] > 我们部署有什么规矩？
…（回答里会提到 staging 环境和周四，措辞随模型变）
```

为什么：历史按会话隔离（`.sessions/recall-check.json`），记忆却是全局单文件 `memory/cli.md`，
`/new` 只换历史、不换记忆文件，所以新会话照样能召回。

### 2.3 从哪看出「真的召回了」

```text
[recall-check] > /trace
[trace]
  #1 model ok … [ …ms] usage=… context: 未压缩 chars=… tokens≈…；memory_hits=1
  落盘：D:\mini-agent\.trace\<runId>\trace.markdown
```

同时 `.trace/<runId>/trace.markdown` 里会有一节：

```text
## #2 memory.inject（turn 1）

- 命中：1 条
- 查询：我们部署有什么规矩？
- 注入：[相关记忆] - (2026-11-06) [#部署] 部署必须走 staging 环境，生产发布只在周四进行
```

为什么：召回发生在**每次模型调用前**，用「最后一条 user 消息」做词面打分
（命中词 ×1.0、完整短语 +3、`#tag` 命中 +1.5、近因、长度惩罚），低于 0.5 分不注入。
它不是向量检索：提问用词要和记忆重合，这里共同的词是「部署」。
换成「上线流程是什么」这种完全不重合的说法，很可能召回不到——这是当前设计的已知边界。

---

## 3. 会话管理：/sessions、/new、/use、/reset

整段可复制（最后一段要先 `/exit` 再重启，模拟第二天回来续聊）：

```text
[cli] > /sessions
[sessions] 目录：D:\mini-agent\.sessions
  * cli  消息 4 条  更新于 2026-11-06 10:12（当前）

[cli] > /new work
已新建并切换到会话 work（只换历史）
  记忆文件：D:\mini-agent\memory\cli.md（全局共享，未变）

[work] > 记一下：work 这个会话只用来写文档
…（回答）

[work] > /exit
```

```text
# 重新 npm start 之后
[cli] > /use work
已切换到会话 work（2 条历史消息）
  记忆文件：D:\mini-agent\memory\cli.md（全局共享，未变）

[work] > 这个会话是干什么用的？
…（能接上前文：写文档）
```

为什么：每次 run 结束会把本轮完整历史覆盖写进 `.sessions/work.json`，
重启后 `/use work` 把它读回来，所以能续聊。记忆仍是同一个文件，切会话不换记忆。

`/reset` 只清历史、不删记忆：

```text
[work] > /reset
会话 work 的对话历史已清空并落盘（记忆文件保留）

[work] > /sessions
[sessions] 目录：D:\mini-agent\.sessions
    cli  消息 … 条  更新于 …
  * work  消息 0 条  更新于 …（当前）

[work] > 我们部署有什么规矩？
…（仍然答得出 staging / 周四，因为记忆没被删）
```

`/del` 删除会话（必须手输 `y`，同样不动记忆文件）：

```text
[work] > /del work
即将删除会话 work：0 条历史消息
  记忆文件 D:\mini-agent\memory\cli.md 是全局共享的，不会被删除
确认删除请输入 y，其它任意输入取消：y
已删除会话 work
当前会话回到 cli
```

已知边界：没有删除单条记忆的命令，想让某段记忆消失只能手工编辑 `memory/cli.md`。

---

## 4. 上下文压缩

三层压缩在 `src/context.ts`，loop 在**每轮调模型之前**跑一次。触发条件：

| 层 | 什么时候触发 | 效果 |
| --- | --- | --- |
| 第 1 层 | 每轮都跑 | 最近 3 轮原样；更老的 tool 消息 ≥1200 字符裁成「首 600 + 尾 300」，toolCalls 参数 >400 字符截断。只瘦身，不删消息 |
| 第 2 层 | 消息数 >40 **或** 估算 token >12000 **或** 轮次 >15 | system + 最近 6 轮保留，中段压成一条 `[历史摘要]`；已存在的摘要会与新增中段一起重压，不堆叠 |
| 第 3 层 | 第 2 层失败（摘要器抛错/超时/返回空/摘要不够短），或压缩后仍超 token 预算 | 硬保留最近 12 轮 + 一条硬摘要；仍超预算就整轮丢弃，保底 system + 最近 2 轮 |

token 是**估算**（ASCII 4 字符 ≈ 1 token，CJK 1 字 ≈ 1 token），只用于触发阈值与报告节省量。

### 4.1 最快看到三层效果：离线脚本（不联网、不花 token）

```bash
npx tsx examples/compaction-demo.ts
```

预期输出（节选，数字固定、可复现）：

```text
场景 1 · 第 1 层：老消息降载（每轮都会跑，只瘦身不删消息）
压缩前：25 条消息 / 6274 字符 / 估算 1939 token
压缩后：25 条消息 / 3212 字符 / 估算 1191 token
命中层级：layer1 裁剪 4 处，layer2 压缩 0 条消息，layer3 兜底 未触发
…
场景 2 · 第 2 层：超阈值摘要（system + 最近 6 轮保留，中段压成一条摘要）
压缩前：81 条消息 / 4353 字符 / 估算 2353 token
压缩后：26 条消息 / 1493 字符 / 估算 829 token
命中层级：layer1 裁剪 0 处，layer2 压缩 56 条消息，layer3 兜底 未触发
…
场景 3 · 第 3 层兜底：摘要器失败时不调模型，保留最近 12 轮 + 硬摘要
命中层级：layer1 裁剪 0 处，layer2 压缩 0 条消息，layer3 兜底 触发
…
场景 4 · 第 3 层预算兜底：摘要完仍超 maxTokens，从最早整轮丢到保底 2 轮
命中层级：layer1 裁剪 3 处，layer2 压缩 24 条消息，layer3 兜底 触发

小结（同一份对话在不同条件下命中的层级不同）
  1. 第 1 层：消息 25 → 25 条，估算 1939 → 1191 token，裁剪 4 处
  2. 第 2 层：消息 81 → 26 条，估算 2353 → 829 token，中段压缩 56 条
  3. 第 3 层（摘要失败）：消息 81 → 50 条，估算 2353 → 1496 token，丢弃 32 条
  4. 第 3 层（预算兜底）：消息 49 → 9 条，估算 6061 → 1815 token，保留 2 轮
```

为什么：脚本用假 `ModelClient`（第 2 层返回固定摘要、第 3 层故意抛错）在内存里造长对话，
只调 `ContextEngine.fit()`，不联网、不读 `.env`、不写 `.trace` / `.sessions`，随时可重复跑。

### 4.2 在 REPL 里真触发一次（连问 16 轮）

第 2 层的轮次阈值是 `>15`，所以连问 16 轮必定触发。整段粘贴即可（每行都会依次执行）：

```text
/new compact-demo
第 1 轮：用一句话说明你在做什么
第 2 轮：用一句话说明你在做什么
第 3 轮：用一句话说明你在做什么
第 4 轮：用一句话说明你在做什么
第 5 轮：用一句话说明你在做什么
第 6 轮：用一句话说明你在做什么
第 7 轮：用一句话说明你在做什么
第 8 轮：用一句话说明你在做什么
第 9 轮：用一句话说明你在做什么
第 10 轮：用一句话说明你在做什么
第 11 轮：用一句话说明你在做什么
第 12 轮：用一句话说明你在做什么
第 13 轮：用一句话说明你在做什么
第 14 轮：用一句话说明你在做什么
第 15 轮：用一句话说明你在做什么
第 16 轮：用一句话说明你在做什么
```

预期：前 15 轮都只有回答；**第 16 轮**回答照旧，但发模型之前已经压缩过——
默认模式看不到这点，需要 `/verbose` 或 `/trace`：

```text
/verbose
```

下一轮（或对第 16 轮执行 `/trace`）会出现：

```text
[trace] session=compact-demo turns=1 stop=final tools=0 total=…ms
  #1 model ok … [ …ms] usage=… context: layer1=0 layer2=20 layer3=0 chars …->… tokens≈…（layer2 触发：消息数 …/40、估算 token …/12000、轮次 16/15；layer2 生效：20 条中段消息压成 1 条摘要（… -> … 字符））；memory_hits=…
  #2 final … [0ms]
[trace] 落盘：D:\mini-agent\.trace\<runId>\trace.markdown
```

为什么：第 16 轮时 messages 大致是 1 条 system + 16 轮（每轮 user + assistant）共 33 条，
本轮有记忆命中时还会多 1 条 `[相关记忆]` system 消息（34 条，同样不影响结论）；
`轮次 16 > 15` 命中第 2 层；保留最近 6 轮，前 10 轮（20 条）被压成一条 `[历史摘要]`。

另一条触发路径是 token：让它干重活（例如「把 README.md 全文读完并逐节总结」），
长 tool 回执会一轮轮累积到 `估算 token >12000`；此时 trace 里的触发说明同样是
`layer2 触发：…估算 token …/12000…`，只是数字先撞线的是 token 那一项。

### 4.3 触发后从哪看出被压过

三个地方，任选：

1. **`/verbose` 或 `/trace` 的那一行**：`context: layer1=… layer2=… layer3=… chars X->Y tokens≈Z`，
   后面括号里是引擎自己给的说明（「layer2 触发：……」「layer2 生效：20 条中段消息压成 1 条摘要」）；
2. **落盘文件 `.trace/<runId>/trace.markdown`** 的 `context.compact` 小节：

   ```text
   ## #3 context.compact（turn 1）

   - 层级：layer1=0 layer2=20 layer3=0
   - 字符：… -> …，token≈…
   - 丢弃消息：19 条
   - note：layer2 触发：消息数 …/40、估算 token …/12000、轮次 16/15
   - note：layer2 生效：20 条中段消息压成 1 条摘要（… -> … 字符）
   ```

3. **usage 的 prompt token 不再线性增长**：同长度的问题连问，压缩后 `prompt` 会突然回落。

注意：`/sessions` 显示的消息条数**不会因为压缩减少**——压缩只作用于「发给模型的那一份」，
`.sessions/<id>.json` 里始终是全量历史，所以续聊和复盘都不丢东西。

第 3 层平时看不到：只有摘要器真的失败时才会出现（模型 key 失效、额度耗尽、摘要超过 15 秒等），
那时 trace 里 `layer3=1`，消息里会出现 `[历史摘要] 【兜底】摘要器不可用（…），已丢弃 N 条较早消息`。
想不花钱看这一幕，就跑 4.1 的离线脚本。

---

## 5. trace / 详细模式怎么看

### 5.1 默认：只有回答

```text
[cli] > 你好
你好！有什么可以帮你的？
```

预期：除此之外没有任何输出——没有 trace 行、没有 usage、没有落盘路径。

### 5.2 三种打开方式

| 方式 | 作用范围 | 适用 |
| --- | --- | --- |
| `/verbose` | 开关，切换后**之后的每轮**都打印明细（`/verbose on` / `/verbose off` 可显式指定） | 边聊边看 |
| `npm start -- --verbose` | 进程启动就打开 | 一次性观察整段会话 |
| `/trace` | 只看**上一轮**，不受开关影响 | 事后回看 |

```text
[cli] > /verbose
详细模式：已开启（trace 明细 / usage 汇总 / 落盘路径）

[cli] > 帮我算 1+1
2

[trace] session=cli turns=2 stop=final tools=1 total=…ms
  #1 model ok 发起 1 次工具调用：calculator [ …ms] usage=…
  #2 tool  calculator({"expression":"1+1"}) -> ok 1+1 = 2 [0ms]
  #3 model ok 2 [ …ms] usage=…
  #4 final … [0ms]
[trace] 落盘：D:\mini-agent\.trace\<runId>\trace.markdown
[usage] total=…（prompt=… / completion=…），调用 2 次，失败 0 次，重试 0 次
```

`npm start -- --verbose` 的 banner 会多出会话目录、记忆文件、trace 目录、预算与命令清单几行。

### 5.3 /trace 只看上一轮

```text
[cli] > /trace
[trace]
  #1 model ok … [ …ms] usage=… context: 未压缩 chars=… tokens≈…；memory_hits=…
  #2 final … [0ms]
  落盘：D:\mini-agent\.trace\<runId>\trace.markdown
```

刚启动还没对话过时：

```text
[cli] > /trace
[trace] 暂无记录
  落盘：暂无（还没发起过对话）
```

切换会话（`/new` `/use`）或 `/reset` 后，`/trace` 会重新变空——它只记当前会话的上一轮。

### 5.4 落盘文件里有什么

每次输入生成一个目录：

```text
.trace/
└─ <runId>/                 # 本地时间 + 随机后缀，例如 20261106-101714-7d9a
   ├─ trace.markdown        # 事件流 + 末尾完整 messages
   └─ snapshots/            # 只存「被覆盖文件」的原内容
```

`trace.markdown` 的小节名固定：`run.start`、`memory.inject`、`context.compact`、
`model.reply`、`tool.call`、`tool.result`、`fs.write`、`run.end`，
末尾是 `## 完整 messages（复现用，共 N 条）`。每节先人读要点，再一段 json（方便脚本 `JSON.parse` 复现）。

```powershell
Get-Content .trace\<runId>\trace.markdown | Select-Object -First 80
```

```bash
sed -n '1,80p' .trace/<runId>/trace.markdown
```

为什么不做成工具：trace 是给人复盘的，塞回模型上下文只会占 token；所以没有 `read_trace`，
要看就直接读文件。

### 5.5 两个开关互不影响

- `--usage` 只负责把用量写进 `.agent-usage.json`（或 `AGENT_USAGE_FILE` 指定路径），不控制打印；
- `--verbose` 只控制打印，不落盘；
- 两者可以同时用；`AGENT_BUDGET_TOKENS` 是全局预算，与它们都无关。

---

## 附：示例文件清单

| 文件 | 用途 |
| --- | --- |
| `examples/README.md` | 本文件，可复制片段 |
| `examples/compaction-demo.ts` | 离线压缩演示，`npx tsx examples/compaction-demo.ts` |

`examples/compaction-demo.ts` 的约束：只 import `src/context.ts` 的公开 API 与 `src/types.ts` 的类型，
不联网、不需要 API key、不读 `.env`、不写 `.trace` / `.sessions`，可以在任何机器上重复跑。
