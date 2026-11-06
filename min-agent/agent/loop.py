"""Agent loop. History may be compressed before the model call."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from agent.limits import DEFAULT_COMPRESS_CHARS, DEFAULT_MAX_STEPS, DEFAULT_RECENT_TURNS, env_int
from llm.client import ChatError, MissingApiKeyError
from llm.parse import FORMAT_RULES, ToolCall, parse_assistant
from sessions.compress import compress_history
from tools.registry import ToolRegistry

CompleteFn = Callable[[list[dict[str, str]]], str]

_LOOP_RULES = """需要工具时，输出 <tool_call> 标签，并且不要输出 <answer>。
运行时会执行这些调用，并把结果以 <tool_result> 消息发回。
拿到所需结果后，只回复 <answer>，不要再带 <tool_call>。
不要编造工具结果。
"""


@dataclass
class AgentResult:
    answer: str
    trace: list[str] = field(default_factory=list)
    messages: list[dict[str, str]] = field(default_factory=list)
    error: str = ""


def resolve_max_steps(value: int | None = None) -> int:
    return env_int("AGENT_MAX_STEPS", DEFAULT_MAX_STEPS, value)


def run_turn(
    user_text: str,
    *,
    session_id: str,
    history: list[dict[str, str]],
    registry: ToolRegistry,
    complete_fn: CompleteFn,
    max_steps: int | None = None,
    compress_chars: int | None = None,
    recent_turns: int | None = None,
) -> AgentResult:
    """Run one user turn until an answer, an API error, or max_steps."""
    steps = resolve_max_steps(max_steps)
    chars = env_int("AGENT_COMPRESS_CHARS", DEFAULT_COMPRESS_CHARS, compress_chars)
    keep = env_int("AGENT_RECENT_TURNS", DEFAULT_RECENT_TURNS, recent_turns)
    history, compressed = compress_history(history, max_chars=chars, keep_turns=keep)
    messages: list[dict[str, str]] = [
        {"role": "system", "content": _system_content(registry)},
        *history,
        {"role": "user", "content": user_text},
    ]
    trace: list[str] = []
    if compressed:
        trace.append(f"compressed older turns into [memory]; kept {keep} recent turns")

    for step in range(1, steps + 1):
        try:
            raw = complete_fn([dict(item) for item in messages])
        except (MissingApiKeyError, ChatError, OSError) as exc:
            trace.append(f"step {step}: api error: {exc}")
            return AgentResult(answer="", trace=trace, messages=messages, error=str(exc))
        if not isinstance(raw, str):
            trace.append(f"step {step}: api error: chat response was not text")
            return AgentResult(
                answer="",
                trace=trace,
                messages=messages,
                error="chat response was not text",
            )

        parsed = parse_assistant(raw)
        messages.append({"role": "assistant", "content": raw})
        if parsed.tool_calls:
            feedback = _run_tools(parsed.tool_calls, parsed.notes, session_id, registry, trace, step)
            messages.append({"role": "user", "content": feedback})
            if step == steps:
                break
            continue
        if parsed.answer:
            if parsed.notes:
                trace.append(f"step {step}: notes: {'; '.join(parsed.notes)}")
            trace.append(f"step {step}: answer")
            return AgentResult(answer=parsed.answer, trace=trace, messages=messages)
        detail = "; ".join(parsed.notes) or "response had no <tool_call> or <answer>"
        trace.append(f"step {step}: parse: {detail}")
        if step == steps:
            return AgentResult(
                answer="",
                trace=trace,
                messages=messages,
                error=f"could not parse a reply: {detail}",
            )
        messages.append(
            {
                "role": "user",
                "content": (
                    f"Could not parse your reply ({detail}). "
                    "Use <tool_call> tags or a final <answer>."
                ),
            }
        )

    return AgentResult(
        answer="",
        trace=trace,
        messages=messages,
        error=f"stopped after {steps} steps without an answer",
    )


def _system_content(registry: ToolRegistry) -> str:
    schemas = json.dumps(registry.list_schemas(), ensure_ascii=False)
    return f"{FORMAT_RULES}\n{_LOOP_RULES}\n工具 schema：\n{schemas}"


def _run_tools(
    calls: tuple[ToolCall, ...],
    notes: tuple[str, ...],
    session_id: str,
    registry: ToolRegistry,
    trace: list[str],
    step: int,
) -> str:
    blocks: list[str] = []
    for call in calls:
        try:
            result = registry.call(call.name, call.arguments, session_id=session_id)
        except Exception as exc:
            detail = str(exc) or exc.__class__.__name__
            trace.append(f"step {step}: tool {call.name} failed: {detail}")
            blocks.append(_tool_result(call.name, detail, error=True))
            continue
        trace.append(f"step {step}: tool {call.name}")
        blocks.append(_tool_result(call.name, _dump(result), error=False))
    for note in notes:
        trace.append(f"step {step}: note: {note}")
        blocks.append(f"<note>{note}</note>")
    return "\n".join(blocks)


def _tool_result(name: str, body: str, *, error: bool) -> str:
    safe = (
        name.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "")
        .replace(">", "")
    )
    flag = ' error="true"' if error else ""
    return f'<tool_result name="{safe}"{flag}>\n{body}\n</tool_result>'


def _dump(result: Any) -> str:
    try:
        return json.dumps(result, ensure_ascii=False)
    except TypeError:
        return str(result)
