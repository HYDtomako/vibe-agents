"""Per-session todos. The CLI stores each session's list in its JSON file."""

from __future__ import annotations

from typing import Any

from tools.registry import Tool, object_schema

_ITEMS: dict[str, list[dict[str, Any]]] = {}


def clear_todos() -> None:
    _ITEMS.clear()


def export_todos(session_id: str) -> list[dict[str, Any]]:
    return [dict(item) for item in _ITEMS.get(session_id, [])]


def replace_todos(session_id: str, items: list[dict[str, Any]]) -> None:
    cleaned: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict) or isinstance(item.get("id"), bool):
            continue
        try:
            cleaned.append(
                {
                    "id": int(item["id"]),
                    "text": str(item["text"]),
                    "done": bool(item.get("done", False)),
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    if cleaned:
        _ITEMS[session_id] = cleaned
    else:
        _ITEMS.pop(session_id, None)


def todo(
    action: str,
    session_id: str,
    text: str | None = None,
    item_id: int | str | None = None,
) -> dict[str, Any]:
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("session_id is required")
    session_id = session_id.strip()
    bucket = _ITEMS.setdefault(session_id, [])
    if action == "add":
        if not isinstance(text, str) or not text.strip():
            raise ValueError("text is required")
        next_id = bucket[-1]["id"] + 1 if bucket else 1
        bucket.append({"id": next_id, "text": text.strip(), "done": False})
    elif action == "list":
        pass
    elif action in {"done", "remove"}:
        target = _item_id(item_id)
        for index, item in enumerate(bucket):
            if item["id"] == target:
                if action == "remove":
                    bucket.pop(index)
                else:
                    item["done"] = True
                break
        else:
            raise ValueError(f"no todo with id {target}")
    else:
        raise ValueError("action must be add, list, done, or remove")
    return {"session_id": session_id, "items": [dict(item) for item in bucket]}


def _item_id(item_id: int | str | None) -> int:
    if isinstance(item_id, bool) or item_id is None:
        raise ValueError("item_id is required")
    if isinstance(item_id, int):
        return item_id
    if isinstance(item_id, str) and item_id.strip().lstrip("-").isdigit():
        return int(item_id)
    raise ValueError("item_id must be an integer")


TODO = Tool(
    name="todo",
    description=(
        "Add, list, complete, or remove todos for the current session. "
        "action is add (needs text), list, done (needs item_id), or remove (needs item_id)."
    ),
    parameters=object_schema(
        {
            "action": {
                "type": "string",
                "enum": ["add", "list", "done", "remove"],
                "description": "What to do with the session todo list.",
            },
            "text": {"type": "string", "description": "Todo text. Required for add."},
            "item_id": {
                "type": "integer",
                "description": "Todo id. Required for done and remove.",
            },
        },
        ["action"],
    ),
    handler=todo,
)
