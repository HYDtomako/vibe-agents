# AI 提示词与解题记录

下面这些字符串是正在运行的 agent 实际发送的指令。它们写在代码里（`llm/parse.py` 与 `agent/loop.py`），由 `agent.loop._system_content` 拼在一起。

## 系统提示

`llm/parse.py` 中的 `FORMAT_RULES`：

```text
只使用下面这些标签回复：
<think>
可选的推理过程
</think>
<tool_call>
{"name":"calculator","arguments":{"expression":"2+2"}}
</tool_call>
<answer>
给用户的最终答案
</answer>

可以省略 <think>。每次工具调用使用一个 <tool_call> 标签；不需要工具时不要输出工具标签。
arguments 必须是 JSON 对象。不要用 markdown 代码块包裹这些标签。
工具调用只是提议。不要编造工具结果。
```

`agent/loop.py` 中的 `_LOOP_RULES`，接在格式规则后面：

```text
需要工具时，输出 <tool_call> 标签，并且不要输出 <answer>。
运行时会执行这些调用，并把结果以 <tool_result> 消息发回。
拿到所需结果后，只回复 <answer>，不要再带 <tool_call>。
不要编造工具结果。
```

然后提示词再加上 `工具 schema：`，以及 `build_default_registry().list_schemas()` 返回的 JSON。这份列表是 calculator、search、todo 和 weather。客户端把系统消息、已存历史（若有 `[memory]` 摘要则包含在内）和新的用户句子，POST 到 `{DEEPSEEK_BASE_URL}/chat/completions`。

压缩没有第二条隐藏提示。摘要是对较早轮次的确定性截取，不是另一次模型调用。

## 解题记录

- calculator 不能使用 Python 的 `eval`。AST 白名单只接受数字和 `+ - * / // % **`。有一条测试在源码里搜索子串 `eval(`，也匹配到了名为 `_eval` 的辅助函数，于是把该函数改了名。

- 最初的命令行会回显每一行。agent 循环成为默认路径之后，那些冒烟测试仍期望 `[stub] received:`。现在它们改用模拟的补全，或在未配置模型时断言缺少密钥的提示。

- `/call` 和 `/ask` 会绕过循环，已经删掉。打出一句话是到达模型的唯一方式。保留的命令是 `/tools`、`/session`、`/quit` 和 `/exit`。TUI 按钮调用的也是这些命令。

- 会话文件本来可能写在 `sessions` 这个 Python 包旁边。现在写到 `sessions/data/<id>.json`（`SESSION_DIR`），让代码和对话记录分开。`/session new` 与 `/session <id>` 会先保存当前文件，再加载另一个 id，避免 todos 和历史混在一起。

- 若把每条已存消息都算作用户轮次，工具结果会被当成新问题。压缩按人类轮次分组，并保留最后 K 轮。`[memory]` 块随文件重新加载，并在下一次请求中放在系统提示之后。

- trace 日志不能包含 API 密钥。追加一行之前，会把 `DEEPSEEK_API_KEY` 和 `WEATHER_API_KEY` 的值换成 `[redacted]`，条件是密钥至少 8 个字符。

- Textual 界面需要和命令行使用同一套上限、压缩和写文件逻辑。两边都调用 `SessionRunner.handle`，没有第二套循环。
