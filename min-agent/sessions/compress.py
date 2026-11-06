"""Shrink stored history before the next model request.

A human turn starts at a user message that is not a tool result, a parser
retry, or a previous [memory] summary. When the history is longer than the
character threshold and there are more than K human turns, older turns become
one [memory] summary and the latest K turns stay verbatim.
"""

from __future__ import annotations

MEMORY_PREFIX = "[memory]\n"
_CLIP = 80


def is_human_message(message: dict[str, str]) -> bool:
    if message.get("role") != "user":
        return False
    content = message.get("content", "")
    if content.startswith(MEMORY_PREFIX):
        return False
    if content.startswith("<tool_result"):
        return False
    if content.startswith("Could not parse your reply"):
        return False
    return True


def compress_history(
    messages: list[dict[str, str]],
    *,
    max_chars: int,
    keep_turns: int,
) -> tuple[list[dict[str, str]], bool]:
    copied = [dict(item) for item in messages]
    if _chars(copied) <= max_chars:
        return copied, False
    turns = _split_turns(copied)
    keep = max(1, keep_turns)
    if len(turns) <= keep:
        return copied, False
    older = turns[:-keep]
    recent = [item for turn in turns[-keep:] for item in turn]
    summary = _summarize(older)
    return [{"role": "user", "content": summary}, *recent], True


def _split_turns(messages: list[dict[str, str]]) -> list[list[dict[str, str]]]:
    turns: list[list[dict[str, str]]] = []
    current: list[dict[str, str]] = []
    for message in messages:
        if is_human_message(message) and current:
            turns.append(current)
            current = []
        current.append(message)
    if current:
        turns.append(current)
    return turns


def _chars(messages: list[dict[str, str]]) -> int:
    return sum(len(item.get("content", "")) for item in messages)


def _summarize(turns: list[list[dict[str, str]]]) -> str:
    lines = [MEMORY_PREFIX.rstrip(), "Summary of earlier turns:"]
    for turn in turns:
        for message in turn:
            lines.append(f"- {message.get('role', 'user')}: {_clip(message.get('content', ''))}")
    return "\n".join(lines)


def _clip(text: str) -> str:
    flat = " ".join(text.split())
    if len(flat) <= _CLIP:
        return flat
    return flat[: _CLIP - 3] + "..."
