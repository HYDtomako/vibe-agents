"""Interactive CLI. A normal sentence runs the agent loop."""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Callable
from pathlib import Path

from agent.limits import env_flag
from agent.log import append_log, redact
from agent.runtime import SessionRunner, new_session_id, validate_session_id
from sessions.store import SessionError

CompleteFn = Callable[[list[dict[str, str]]], str]


def load_local_env() -> None:
    """Load a local .env when python-dotenv is installed. A missing file is fine."""
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv()


def run_cli(
    input_fn: Callable[[str], str] = input,
    output_fn: Callable[[str], None] = print,
    registry=None,
    complete_fn: CompleteFn | None = None,
    max_steps: int | None = None,
    trace_fn: Callable[[str], None] | None = None,
    session_id: str | None = None,
    session_dir: str | Path | None = None,
    log_dir: str | Path | None = None,
    max_turns: int | None = None,
    max_messages: int | None = None,
    compress_chars: int | None = None,
    recent_turns: int | None = None,
) -> str:
    """Prompt for a session when needed, then run the agent until quit.

    Returns the session id, or an empty string when the id is rejected.
    """
    session_id = _resolve_session_id(session_id, input_fn, output_fn)
    if not session_id:
        return ""
    runner = SessionRunner(
        session_id=session_id,
        session_dir=session_dir,
        log_dir=log_dir,
        registry=registry,
        complete_fn=complete_fn,
        max_steps=max_steps,
        max_turns=max_turns,
        max_messages=max_messages,
        compress_chars=compress_chars,
        recent_turns=recent_turns,
    )
    try:
        output_fn(runner.open())
    except (SessionError, ValueError) as exc:
        output_fn(f"[agent] {exc}")
        return session_id
    output_fn(
        "Type a message for the agent. /tools lists tools. "
        "/session shows or switches sessions. /quit or /exit leaves."
    )
    if trace_fn is None:
        trace_fn = lambda text: _emit_trace(text, runner.log_paths)

    while True:
        try:
            line = input_fn("> ")
        except EOFError:
            output_fn("")
            break
        result = runner.handle(line)
        for entry in result.trace:
            trace_fn(f"[trace] {entry}")
        for text in result.lines:
            output_fn(text)
        if result.quit:
            break
    return runner.session_id


def _resolve_session_id(
    session_id: str | None,
    input_fn: Callable[[str], str],
    output_fn: Callable[[str], None],
) -> str:
    if session_id is not None:
        try:
            return validate_session_id(session_id)
        except ValueError as exc:
            output_fn(f"[agent] {exc}")
            return ""
    while True:
        entered = input_fn("session_id (press Enter to create one): ").strip()
        if not entered:
            return new_session_id()
        try:
            return validate_session_id(entered)
        except ValueError as exc:
            output_fn(f"[agent] {exc}")


def _emit_trace(text: str, log_paths: dict[str, Path | None]) -> None:
    safe = redact(text)
    print(safe, file=sys.stderr)
    path = log_paths.get("path")
    if path is not None:
        append_log(path, safe)


def main(argv: list[str] | None = None) -> None:
    load_local_env()
    parser = argparse.ArgumentParser(prog="min-agent")
    parser.add_argument("--session", default="", help="Resume or create this session id")
    parser.add_argument("--tui", action="store_true", help="Open the Textual interface")
    args = parser.parse_args(argv)
    if args.tui:
        from agent.tui import run_tui

        run_tui(session_id=args.session or None, parse_args=False)
        return
    session_dir = Path(os.environ.get("SESSION_DIR", "").strip() or "sessions/data")
    log_dir: Path | None = None
    if env_flag("AGENT_LOG", True):
        log_dir = Path(os.environ.get("AGENT_LOG_DIR", "").strip() or "logs")
    try:
        run_cli(
            session_id=args.session or None,
            session_dir=session_dir,
            log_dir=log_dir,
        )
    except KeyboardInterrupt:
        print()
