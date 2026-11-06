"""Parse the tagged assistant format documented in llm/schema.md."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

_TAGS = ("think", "tool_call", "answer")
_BLOCK = {
    tag: re.compile(rf"<{tag}>(.*?)</{tag}>", re.IGNORECASE | re.DOTALL) for tag in _TAGS
}

FORMAT_RULES = """只使用下面这些标签回复：
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
"""


@dataclass(frozen=True)
class ToolCall:
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ParsedMessage:
    thinking: str = ""
    tool_calls: tuple[ToolCall, ...] = ()
    answer: str = ""
    notes: tuple[str, ...] = ()


def system_prompt(tool_lines: list[str]) -> str:
    """Format rules plus the registered tool names. Does not ask the model to loop."""
    listing = "\n".join(tool_lines) if tool_lines else "（无）"
    return f"{FORMAT_RULES}\n已注册工具：\n{listing}"


def parse_assistant(raw: str) -> ParsedMessage:
    text = raw or ""
    thinking = _join(_BLOCK["think"].findall(text))
    answer = _join(_BLOCK["answer"].findall(text))
    calls: list[ToolCall] = []
    notes: list[str] = []
    for index, blob in enumerate(_BLOCK["tool_call"].findall(text), start=1):
        call, note = _parse_tool_call(blob, index)
        if call is not None:
            calls.append(call)
        if note:
            notes.append(note)
    for tag in _TAGS:
        if _unclosed(text, tag):
            notes.append(f"unclosed <{tag}>")
    return ParsedMessage(
        thinking=thinking,
        tool_calls=tuple(calls),
        answer=answer,
        notes=tuple(notes),
    )


def format_parsed(parsed: ParsedMessage) -> str:
    lines: list[str] = []
    if parsed.thinking:
        lines.append(f"[think]\n{parsed.thinking}")
    for call in parsed.tool_calls:
        payload = json.dumps(call.arguments, ensure_ascii=False)
        lines.append(f"[tool_call] {call.name} {payload}")
    if parsed.answer:
        lines.append(f"[answer]\n{parsed.answer}")
    for note in parsed.notes:
        lines.append(f"[note] {note}")
    return "\n".join(lines)


def _join(parts: list[str]) -> str:
    return "\n".join(part.strip() for part in parts if part.strip())


def _unclosed(text: str, tag: str) -> bool:
    opens = len(re.findall(rf"<{tag}>", text, flags=re.IGNORECASE))
    closes = len(re.findall(rf"</{tag}>", text, flags=re.IGNORECASE))
    return opens > closes


def _parse_tool_call(blob: str, index: int) -> tuple[ToolCall | None, str | None]:
    try:
        payload = json.loads(blob)
    except json.JSONDecodeError:
        return None, f"skipped tool_call {index}: invalid JSON"
    if not isinstance(payload, dict):
        return None, f"skipped tool_call {index}: expected a JSON object"
    name = payload.get("name")
    if not isinstance(name, str) or not name.strip():
        return None, f"skipped tool_call {index}: name is required"
    if "arguments" not in payload or payload["arguments"] is None:
        arguments: dict[str, Any] = {}
    elif isinstance(payload["arguments"], dict):
        arguments = payload["arguments"]
    else:
        return None, f"skipped tool_call {index}: arguments must be a JSON object"
    return ToolCall(name=name.strip(), arguments=arguments), None
