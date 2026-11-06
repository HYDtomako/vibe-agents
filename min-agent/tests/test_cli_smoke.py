"""Smoke tests for the CLI session loop and slash commands."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from agent.cli import run_cli
from sessions.store import SessionStore

ROOT = Path(__file__).resolve().parents[1]


def _answer(text: str):
    def complete(_messages: list[dict[str, str]]) -> str:
        return f"<answer>{text}</answer>"

    return complete


def test_in_memory_history() -> None:
    store = SessionStore()
    store.create("s1")
    store.append("s1", "user", "ping")
    assert store.history("s1") == [{"role": "user", "content": "ping"}]
    assert store.history("missing") == []


def test_generated_session_echo_and_quit() -> None:
    answers = iter(["", "hello there", "/quit"])
    lines: list[str] = []

    session_id = run_cli(
        input_fn=lambda _prompt: next(answers),
        output_fn=lines.append,
        complete_fn=_answer("noted"),
    )

    assert len(session_id) == 8
    assert any(line.startswith(f"session: {session_id}") for line in lines)
    assert "noted" in lines
    assert lines[-1] == "bye"


def test_named_session_and_exit() -> None:
    answers = iter(["desk", "ping", "/exit", "should-not-run"])
    lines: list[str] = []

    session_id = run_cli(
        input_fn=lambda _prompt: next(answers),
        output_fn=lines.append,
        complete_fn=_answer("pong"),
    )

    assert session_id == "desk"
    assert "pong" in lines
    assert lines[-1] == "bye"
    assert next(answers) == "should-not-run"


def test_eof_exits_cleanly() -> None:
    def fake_input(prompt: str) -> str:
        if prompt.startswith("session_id"):
            return "s"
        raise EOFError

    lines: list[str] = []
    session_id = run_cli(input_fn=fake_input, output_fn=lines.append)
    assert session_id == "s"
    assert "bye" not in lines


def test_packages_import() -> None:
    import agent
    import sessions
    import tools

    assert agent.__version__
    assert hasattr(sessions, "SessionStore")
    assert tools.__doc__


def test_cli_lists_tools() -> None:
    answers = iter(["desk", "/tools", "/session", "/quit"])
    lines: list[str] = []
    session_id = run_cli(input_fn=lambda _prompt: next(answers), output_fn=lines.append)
    assert session_id == "desk"
    tools_line = next(line for line in lines if line.startswith("calculator:"))
    assert "search:" in tools_line
    assert "todo:" in tools_line
    assert "weather:" in tools_line
    assert "session: desk" in lines
    joined = "\n".join(lines)
    assert "/call" not in joined
    assert "/ask" not in joined
    assert lines[-1] == "bye"


def test_cli_subprocess_missing_key_and_quit() -> None:
    env = os.environ.copy()
    env["DEEPSEEK_API_KEY"] = ""
    proc = subprocess.run(
        [sys.executable, "main.py"],
        input="\nhello from smoke\n/quit\n",
        text=True,
        capture_output=True,
        cwd=ROOT,
        env=env,
        timeout=10,
        check=False,
    )
    assert proc.returncode == 0
    assert "DEEPSEEK_API_KEY is unset" in proc.stdout
    assert "bye" in proc.stdout
