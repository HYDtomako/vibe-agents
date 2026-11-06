# Assistant response format

The model reply is plain text with three tags. This is the only format the parser accepts.

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

## Tags

- `<think>` is optional. Put short reasoning here. Several think blocks are joined with newlines.
- `<tool_call>` is optional and repeatable, one call per tag, in the order they should run later. The body is one JSON object:
  - `name` (string, required): a registered tool name
  - `arguments` (object): tool arguments. Omit it to mean `{}`.
- `<answer>` is the user-facing reply. Several answer blocks are joined with newlines.

Canonical order is think, then tool calls, then answer. The parser accepts the tags in any order.

## Missing or invalid pieces

- A missing tag yields an empty string or an empty tool list. That is not an error.
- Invalid tool JSON, a non-object body, a missing `name`, or `arguments` that is not an object: that call is skipped and a note is recorded. Other calls and the answer are kept.
- An opening tag without its close is ignored as content and recorded as a note (`unclosed <tool_call>`).

Do not wrap the tags in markdown fences. The parser still finds tags inside a fence, but fences are not part of the format.

The agent loop executes `<tool_call>` tags, sends `<tool_result>` messages, and waits for a later reply whose final tag is `<answer>`.
