# 面试演示剧本

在 `min-agent/` 里照着说。现场需要可用的 `DEEPSEEK_API_KEY`（放在 `.env`，不要提交）。模型用词会变，下面的「期望现象」只盯运行时一定能看见的：它有没有去调工具、待办有没有串台、文件里有没有 `[memory]`。压缩不想连模型时，直接跑文末的脚本。

```bash
cd min-agent
python main.py --session <id>
```

TUI 是同一套逻辑：`python main.py --tui --session <id>`。

## 1. 双 session 隔离

演示步骤：

1. 窗口 A：`python main.py --session shanghai`
2. 说：`查一下上海天气，再把「带把伞」记到待办。`
3. 窗口 B：`python main.py --session beijing`
4. 说：`查一下北京天气，再把「订返程车票」记到待办。`
5. 回到 A，说：`我的待办里有什么？`

一个窗口也行：在 shanghai 说完后输入 `/session beijing`，说完再 `/session shanghai`。

期望现象：

- A 的待办里是「带把伞」，没有「订返程车票」。B 正好反过来。
- 问 A「刚才那个城市多少度」时，它说的是上海，不是北京。
- 磁盘上是 `sessions/data/shanghai.json` 和 `sessions/data/beijing.json`，各记各的。
- 没设 `WEATHER_API_KEY` 时，天气是模拟的：18°C，多云，`source` 为 `mock`。

## 2. 纯对话追问

演示步骤：

1. `python main.py --session chat`
2. 说：`我叫林夏，这周末去上海见客户。先记住就行，别查工具。`
3. 接着说：`我叫什么，这周末去哪？`

期望现象：

- 两轮都没有调用工具，stderr 只有 `[trace] step 1: answer`。
- 第二句能答出「林夏」和「上海」。会话文件里还留着第一句原话。

## 3. 带工具的追问

演示步骤：

1. `python main.py --session dinner`
2. 说：`账单 286 块，按 15% 算一下小费。`
3. 接着说：`刚才那个小费，再加 10 块，一共多少？`

期望现象：

- 第一轮先出现 `[trace] step 1: tool calculator`，再出现 `step 2: answer`。答案里是 42.9（286 的 15%）。
- 第二轮会再调一次 calculator。答案里是 52.9。
- 如果它没发 `<tool_call>` 就直接报数，可以指给面试官看：系统提示要求先调用工具，不要自己编结果。

## 4. 压缩触发

旧对话太长时，更早的轮次收成一条以 `[memory]` 开头的用户消息，最近几轮原文留下。下一次发给模型的内容是：系统提示、这段压缩后的历史、你刚说的新句子。

不想现场打很多字：

```bash
python scripts/demo_compress.py
```

期望现象：

- 「压缩前」是一段出差对话：上海天气、待办、晚饭、小费。
- 「压缩后」第一条是 `[memory]`，里面能看到上海天气和待办；「晚饭」「小费」两轮还在原文里。
- 「下次请求」最前面是 `system`，接着是 `[memory]`，然后是保留的最近两轮，最后一条是新问题「刚才上海多少度」。

用真模型时把阈值调小（默认 6000 字、保留 6 轮，短对话压不出来）：

```bash
AGENT_COMPRESS_CHARS=200 AGENT_RECENT_TURNS=2 AGENT_LOG=0 python main.py --session squeeze
```

先连续说三句比较完整的话，每句等它答完，再随便追问一句。

期望现象：

- 追问那句的 stderr 出现 `[trace] compressed older turns into [memory]; kept 2 recent turns`。
- `sessions/data/squeeze.json` 里有一条以 `[memory]` 开头的用户消息，最近 2 轮仍是原文。
- 退出后再 `python main.py --session squeeze`，下一句会把文件里的 `[memory]` 放在系统提示后面。

## 5. calculator

演示步骤：说 `286 块的 15% 小费是多少？`

期望现象：trace 里有 `tool calculator`，答案是 42.9。这是白名单算术，不是 Python `eval`。

## 6. weather

演示步骤：确认没设 `WEATHER_API_KEY`，说 `上海现在多少度？`

期望现象：trace 里有 `tool weather`。结果是模拟预报，大约是 `Mock weather for 上海: 18°C, partly cloudy.`，并注明 `WEATHER_API_KEY is unset`。口头答案应顺着这句来说。

## 7. todo

演示步骤：

1. `python main.py --session chores`
2. 说：`帮我记一条待办：周五带蝴蝶酥给客户。`
3. 说：`我待办里现在有什么？`

期望现象：两轮都会调用 `todo`。第二轮能看见「周五带蝴蝶酥给客户」。换一个 session 再问，这条不在。

## 8. search

演示步骤：说 `搜一下计算器是怎么做的。`

期望现象：trace 里有 `tool search`，结果是本地假数据，标题里有 `Calculator notes`，`source` 为 `mock`。不会去网上搜。对不上目录时，标题会变成 `Mock result for ...`。
