"""Session transcripts on disk. One JSON file per session id."""

from __future__ import annotations

import json
import re
from pathlib import Path

_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")


class SessionError(Exception):
    """The session file could not be read. It is left untouched."""


def validate_session_id(session_id: str) -> str:
    if not isinstance(session_id, str) or _ID.fullmatch(session_id) is None:
        raise ValueError(
            "session id must be 1-64 characters of letters, digits, '_' or '-'"
        )
    return session_id


class SessionStore:
    def __init__(self, directory: str | Path | None = None) -> None:
        self.directory = Path(directory) if directory is not None else None
        self._messages: dict[str, list[dict[str, str]]] = {}
        self._turns: dict[str, int] = {}
        self._todos: dict[str, list[dict]] = {}

    def create(self, session_id: str) -> None:
        validate_session_id(session_id)
        self._messages.setdefault(session_id, [])
        self._turns.setdefault(session_id, 0)
        self._todos.setdefault(session_id, [])

    def load(self, session_id: str) -> bool:
        """Load `directory/<id>.json`. Returns True when the file existed."""
        validate_session_id(session_id)
        self.create(session_id)
        if self.directory is None:
            return False
        path = self._path(session_id)
        if not path.exists():
            return False
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SessionError(
                f"could not read {path.name}: {exc}. The file was not changed."
            ) from exc
        if not isinstance(data, dict) or not isinstance(data.get("messages", []), list):
            raise SessionError(f"could not read {path.name}. The file was not changed.")
        messages = []
        for item in data.get("messages", []):
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            content = item.get("content")
            if isinstance(role, str) and isinstance(content, str):
                messages.append({"role": role, "content": content})
        self._messages[session_id] = messages
        turns = data.get("user_turns", 0)
        self._turns[session_id] = turns if isinstance(turns, int) and not isinstance(turns, bool) else 0
        todos = data.get("todos", [])
        self._todos[session_id] = list(todos) if isinstance(todos, list) else []
        return True

    def save(self, session_id: str) -> None:
        if self.directory is None:
            return
        validate_session_id(session_id)
        self.directory.mkdir(parents=True, exist_ok=True)
        path = self._path(session_id)
        payload = {
            "id": session_id,
            "user_turns": self._turns.get(session_id, 0),
            "messages": self._messages.get(session_id, []),
            "todos": self._todos.get(session_id, []),
        }
        text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(text, encoding="utf-8")
        temporary.replace(path)

    def append(self, session_id: str, role: str, content: str) -> None:
        self.create(session_id)
        self._messages[session_id].append({"role": role, "content": content})

    def replace(self, session_id: str, messages: list[dict[str, str]], *, new_user_turn: bool) -> None:
        self.create(session_id)
        self._messages[session_id] = [dict(item) for item in messages]
        if new_user_turn:
            self._turns[session_id] = self._turns.get(session_id, 0) + 1

    def history(self, session_id: str) -> list[dict[str, str]]:
        return [dict(item) for item in self._messages.get(session_id, [])]

    def user_turns(self, session_id: str) -> int:
        return self._turns.get(session_id, 0)

    def set_todos(self, session_id: str, items: list[dict]) -> None:
        self.create(session_id)
        self._todos[session_id] = [dict(item) for item in items]

    def get_todos(self, session_id: str) -> list[dict]:
        return [dict(item) for item in self._todos.get(session_id, [])]

    def ids(self) -> list[str]:
        return list(self._messages)

    def known_ids(self) -> list[str]:
        """Ids loaded in memory plus JSON files already in the session directory."""
        found = set(self._messages)
        if self.directory is not None and self.directory.exists():
            for path in self.directory.glob("*.json"):
                if _ID.fullmatch(path.stem):
                    found.add(path.stem)
        return sorted(found)

    def _path(self, session_id: str) -> Path:
        if self.directory is None:
            raise SessionError("session directory is not set")
        return self.directory / f"{session_id}.json"
