# min-agent

一个尽量小的 Python agent。普通句子会进入工具循环。每个会话单独存成一个 JSON 文件。

## 安装

在本目录（项目根目录）执行：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

虚拟环境可以不建。`textual` 用于 TUI。工具和聊天客户端使用 Python 标准库（HTTP 用 `urllib`）。`pytest` 用来跑测试。启动时由 `python-dotenv` 加载本地 `.env`。

## 运行

命令行（会询问会话，或直接指定会话名）：

```bash
python main.py
python main.py --session alpha
python -m agent
```

TUI（使用同一批会话文件和同一个 agent 循环）：

```bash
python main.py --tui
python main.py --tui --session alpha
python -m agent.tui
python -m agent.tui --session alpha
```

不带 `--session` 时，TUI 会新建一个短 id，因为终端由 Textual 占用。命令行仍会询问 id，按 Enter 即创建一个。

## 使用会话

在命令行提示处按 Enter 会生成一个短 id。普通句子会送进 agent 循环。`/quit` 或 `/exit` 退出。输入结束时同样退出。

```text
/session
/session new
/session beta
```

`/session` 打印当前 id。`/session new` 先保存当前会话，再开始一个新 id。`/session <id>` 先保存当前会话，再加载该 id（文件还不存在则为空会话）。`new` 是用来生成 id 的子命令，不是某个会话的名字。

设置了 `DEEPSEEK_API_KEY` 后，下面这一轮会调用 calculator，然后给出答案：

```text
what is 12*7
```

模型需要输出 `<tool_call>` 标签。运行时通过 registry 执行，并把 `<tool_result>` 送回去。下一步模型应输出 `<answer>`。命令行打印这个答案。步骤记录以 `[trace]` 打到 stderr；除非 `AGENT_LOG=0`，否则同时追加到 `logs/<session_id>.log`。循环在 `AGENT_MAX_STEPS` 次模型调用后停止（默认 8）。

`/tools` 列出已注册工具。其余文本，包括以斜杠开头的句子，都是普通用户轮次。

回复格式写在 [`llm/schema.md`](llm/schema.md)：

```
<think>
optional reasoning
</think>
<tool_call>
{"name":"calculator","arguments":{"expression":"2+2"}}
</tool_call>
<answer>
final answer for the user
</answer>
```

## 系统设计

| 部分 | 作用 |
| --- | --- |
| `tools/` | Registry，以及 calculator、模拟 search、按会话区分的 todo、weather。模型看到的是 `list_schemas()`。`call()` 执行工具。 |
| `llm/` | 兼容 OpenAI 的 DeepSeek 客户端，以及 `<think>` / `<tool_call>` / `<answer>` 解析器。提示词副本在 [`docs/AI_PROMPTS.md`](docs/AI_PROMPTS.md)。 |
| `agent/loop.py` | 一轮用户输入：组装消息、调用客户端、执行工具调用，直到出现 `<answer>` 或达到步数上限。 |
| `agent/runtime.py` | 打开/保存会话、`/tools`、`/session`、轮次上限。命令行和 TUI 都调用它。 |
| `sessions/` | `store.py` 写入 `sessions/data/<id>.json`。`compress.py` 生成 `[memory]` 摘要。 |
| `agent/limits.py` | 步数、轮次、消息数和压缩的环境变量默认值。 |
| `agent/log.py` | 把同一份 trace 追加到 `logs/<id>.log`，并涂掉环境变量里的密钥。 |
| `agent/cli.py` | 逐行提示。不带 `--tui` 的 `python main.py`。 |
| `agent/tui.py` | Textual 界面。`python -m agent.tui` 或 `python main.py --tui`。 |

## 记忆何时被召回

1. 压缩发生在组装下一次模型请求时：若已存历史长于 `AGENT_COMPRESS_CHARS`，且人类轮次多于 `AGENT_RECENT_TURNS`，更早的轮次会变成一条以 `[memory]` 开头的用户消息。这条消息会写入会话文件。
2. 从磁盘加载：`python main.py --session alpha`、`/session alpha`，或 TUI 的 Open 按钮，会读取 `sessions/data/alpha.json`。若文件里已有 `[memory]` 消息，会一并读入。
3. 下一次模型请求的内容是：当前系统提示（格式规则、循环规则、工具 schema），然后是这份已加载的历史，最后是新的用户句子。摘要不是另一次单独查询。

## 会话

文件：

- 默认是 `sessions/data/<session_id>.json`（可用 `SESSION_DIR` 改目录）。文件里有消息、累计用户轮次数，以及该会话的 todos。
- `logs/<session_id>.log` 收到与 stderr 相同的 trace 行。设 `AGENT_LOG=0` 则只留 stderr。

同一个 id 在重启后会接着用。两个 id 不共享历史或 todos。用两个终端核对：

```bash
python main.py --session alpha
python main.py --session beta
```

也可以在同一个终端里：先在 `alpha` 说一句，再 `/session beta`，再 `/session alpha`。切换之后的模型请求只根据刚加载的文件来组装。文件里的 `[memory]` 摘要会包含在内。

## 记忆

每次模型请求之前，已存历史按字符数计量（`AGENT_COMPRESS_CHARS`，默认 6000）。超过阈值且人类轮次多于 `AGENT_RECENT_TURNS`（默认 6）时，更早的轮次换成一条 `[memory]` 摘要。最近 K 轮原文保留。保存下来的就是这份摘要，下次加载会话时会再读出来。

人类轮次从一条用户消息开始。工具结果、解析重试，以及已有的 `[memory]` 块，都不会新开一轮。

若已经达到 `AGENT_MAX_TURNS`（默认 40）或 `AGENT_MAX_MESSAGES`（默认 200），命令行会打印上限，并且不写文件。

## 工具

`/tools` 打印 registry。用工具的方式是说一句话，例如 `add buy milk to my todos` 或 `what is 12*7`。`/` 是真除法，所以 `7/2` 是 `3.5`。Todos 属于当前活动的 session id。

| 工具 | 行为 |
| --- | --- |
| calculator | 用 AST 白名单做算术，只允许数字和 `+ - * / // % **`。名字、属性、调用会被拒绝。 |
| search | 固定的本地结果。不访问网络。 |
| todo | 对当前 `session_id` 做 `add`、`list`、`done`、`remove`。列表写在该会话的 JSON 文件里。 |
| weather | 未设置 `WEATHER_API_KEY` 时返回模拟预报。设置后调用 OpenWeatherMap。请求失败也返回模拟结果。 |

## 面试演示

照读剧本在 [`docs/DEMOS.md`](docs/DEMOS.md)，按查上海天气、记待办、算小费来讲。不连模型、只看这段对话压缩前后的 messages：

```bash
python scripts/demo_compress.py
```

## 测试

安装之后，在本目录执行：

```bash
python -m pytest -v
```

虚拟环境已激活时，直接运行 `pytest` 是同一条命令。

## 环境变量

把 `.env.example` 复制为 `.env` 再填写本地密钥。不要提交真实密钥。

空值使用默认值。不要把真实密钥写进示例文件。

- 示例里的 `DEEPSEEK_API_KEY` 保持为空。密钥缺失时，普通句子会拒绝调用模型。
- `DEEPSEEK_BASE_URL` 默认 `https://api.deepseek.com`。客户端向 `{base}/chat/completions` 发 POST。
- `DEEPSEEK_MODEL` 默认 `deepseek-flash`。
- `WEATHER_API_KEY` 可选。设置后，`weather` 调用 OpenWeatherMap（`https://api.openweathermap.org/data/2.5/weather`）。为空或请求失败时，工具返回模拟结果。
- `AGENT_MAX_STEPS` 默认一轮用户输入内 8 次模型调用。
- `AGENT_MAX_TURNS` 默认一个会话 40 个用户轮次。
- `AGENT_MAX_MESSAGES` 默认在考虑压缩之后最多 200 条已存消息。
- `AGENT_RECENT_TURNS` 默认压缩时原文保留最近 6 轮。
- `AGENT_COMPRESS_CHARS` 默认已存历史 6000 个字符。
- `AGENT_LOG` 默认开启。`0` 表示 trace 只留在 stderr。
- `AGENT_LOG_DIR` 默认 `logs`。
- `SESSION_DIR` 默认 `sessions/data`。
