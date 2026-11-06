"""Shared session runtime for the CLI and the Textual TUI.

Both front ends call this. It loads and saves the session store, applies turn
caps, and runs the existing agent loop.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from agent.limits import (
    DEFAULT_COMPRESS_CHARS,
    DEFAULT_MAX_MESSAGES,
    DEFAULT_MAX_TURNS,
    DEFAULT_RECENT_TURNS,
    env_int,
)
from agent.log import append_log
from agent.loop import resolve_max_steps, run_turn
from llm.client import ChatClient
from sessions.compress import compress_history
from sessions.store import SessionError, SessionStore, validate_session_id
from tools.registry import ToolRegistry, build_default_registry
from tools.todo import export_todos, replace_todos

CompleteFn = Callable[[list[dict[str, str]]], str]
QUIT_COMMANDS = {"/quit", "/exit"}


def new_session_id() -> str:
    return uuid.uuid4().hex[:8]


def format_tools(registry: ToolRegistry) -> str:
    schemas = registry.list_schemas()
    if not schemas:
        return "(no tools)"
    return "\n".join(
        f"{item['function']['name']}: {item['function']['description']}" for item in schemas
    )


def default_complete(messages: list[dict[str, str]]) -> str:
    return ChatClient().complete(messages)


@dataclass
class LineResult:
    lines: list[str] = field(default_factory=list)
    trace: list[str] = field(default_factory=list)
    quit: bool = False


class SessionRunner:
    def __init__(
        self,
        *,
        session_id: str,
        session_dir: str | Path | None = None,
        log_dir: str | Path | None = None,
        registry: ToolRegistry | None = None,
        complete_fn: CompleteFn | None = None,
        max_steps: int | None = None,
        max_turns: int | None = None,
        max_messages: int | None = None,
        compress_chars: int | None = None,
        recent_turns: int | None = None,
    ) -> None:
        self.session_id = session_id
        self.session_dir = session_dir
        self.log_dir = Path(log_dir) if log_dir is not None else None
        self.store = SessionStore(session_dir)
        self.registry = registry if registry is not None else build_default_registry()
        self.complete_fn = complete_fn or default_complete
        self.steps = resolve_max_steps(max_steps)
        self.turn_limit = env_int("AGENT_MAX_TURNS", DEFAULT_MAX_TURNS, max_turns)
        self.message_limit = env_int("AGENT_MAX_MESSAGES", DEFAULT_MAX_MESSAGES, max_messages)
        self.char_limit = env_int("AGENT_COMPRESS_CHARS", DEFAULT_COMPRESS_CHARS, compress_chars)
        self.keep_turns = env_int("AGENT_RECENT_TURNS", DEFAULT_RECENT_TURNS, recent_turns)
        self.log_paths: dict[str, Path | None] = {"path": None}
        self._resumed = False

    def open(self) -> str:
        """Load the current id. Returns the status line, or raises SessionError."""
        self._resumed = self.store.load(self.session_id) if self.session_dir is not None else False
        if self.session_dir is None:
            self.store.create(self.session_id)
        else:
            replace_todos(self.session_id, self.store.get_todos(self.session_id))
        self._point_log(self.session_id, "resumed" if self._resumed else "new")
        return self.status_line()

    def status_line(self) -> str:
        state = "resumed" if self._resumed else "new"
        return _session_status(self.session_id, state, len(self.store.history(self.session_id)))

    def handle(self, line: str) -> LineResult:
        text = line.strip()
        if not text:
            return LineResult()
        if text in QUIT_COMMANDS:
            return LineResult(lines=["bye"], quit=True)
        if text == "/tools":
            reply = format_tools(self.registry)
            self.store.append(self.session_id, "user", text)
            self.store.append(self.session_id, "assistant", reply)
            _persist(self.store, self.session_id)
            return LineResult(lines=[reply])
        if text == "/session" or text.startswith("/session "):
            return self._switch(text)
        if self.store.user_turns(self.session_id) >= self.turn_limit:
            return LineResult(lines=[_turns_cap_message(self.store.user_turns(self.session_id), self.turn_limit)])
        history = self.store.history(self.session_id)
        preview, _compressed = compress_history(
            history, max_chars=self.char_limit, keep_turns=self.keep_turns
        )
        if len(preview) >= self.message_limit:
            return LineResult(lines=[_messages_cap_message(len(preview), self.message_limit)])
        result = run_turn(
            text,
            session_id=self.session_id,
            history=history,
            registry=self.registry,
            complete_fn=self.complete_fn,
            max_steps=self.steps,
            compress_chars=self.char_limit,
            recent_turns=self.keep_turns,
        )
        self.store.replace(self.session_id, result.messages[1:], new_user_turn=True)
        _persist(self.store, self.session_id)
        shown = result.answer if result.answer else f"[agent] {result.error or 'no answer'}"
        return LineResult(lines=[shown], trace=list(result.trace))

    def _switch(self, line: str) -> LineResult:
        parts = line.split()
        if len(parts) == 1:
            return LineResult(lines=[f"session: {self.session_id}"])
        if len(parts) != 2:
            return LineResult(lines=["[agent] usage: /session, /session new, or /session <id>"])
        if parts[1] == "new":
            target = new_session_id()
        else:
            try:
                target = validate_session_id(parts[1])
            except ValueError as exc:
                return LineResult(lines=[f"[agent] {exc}"])
        if target == self.session_id:
            return LineResult(lines=[f"session: {self.session_id}"])

        _persist(self.store, self.session_id)
        already = target in self.store.ids()
        try:
            resumed = self.store.load(target) if self.session_dir is not None else False
        except SessionError as exc:
            return LineResult(lines=[f"[agent] {exc}"])
        if self.session_dir is None:
            self.store.create(target)
        replace_todos(target, self.store.get_todos(target))
        self.session_id = target
        self._resumed = resumed or already
        state = "resumed" if self._resumed else "new"
        self._point_log(target, state)
        return LineResult(lines=[_session_status(target, state, len(self.store.history(target)))])

    def _point_log(self, session_id: str, state: str) -> None:
        if self.log_dir is None:
            self.log_paths["path"] = None
            return
        path = self.log_dir / f"{session_id}.log"
        self.log_paths["path"] = path
        append_log(path, f"session {session_id} {state}")


def _persist(store: SessionStore, session_id: str) -> None:
    store.set_todos(session_id, export_todos(session_id))
    store.save(session_id)


def _session_status(session_id: str, state: str, count: int) -> str:
    return f"session: {session_id} ({state}, {count} messages)"


def _turns_cap_message(turns: int, limit: int) -> str:
    return (
        f"[agent] This session already has {turns} user turns "
        f"(AGENT_MAX_TURNS={limit}). The session file was not changed. "
        "Start a new session id to continue."
    )


def _messages_cap_message(count: int, limit: int) -> str:
    return (
        f"[agent] This session already has {count} messages "
        f"(AGENT_MAX_MESSAGES={limit}). The session file was not changed. "
        "Start a new session id to continue."
    )
