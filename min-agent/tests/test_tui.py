"""Headless Textual checks. The model is mocked."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from agent.runtime import SessionRunner
from agent.tui import AgentApp, render_stored_message

ROOT = Path(__file__).resolve().parents[1]


def test_render_memory_and_answer() -> None:
    assert render_stored_message(
        {"role": "user", "content": "[memory]\nSummary of earlier turns:\n- user: ancient"}
    ) == "memory: Summary of earlier turns:"
    assert render_stored_message(
        {"role": "assistant", "content": "<answer>84</answer>"}
    ) == "agent: 84"
    assert render_stored_message({"role": "user", "content": "<tool_result name=\"calculator\">\n{}\n</tool_result>"}) == ""


def test_main_tui_flag_does_not_reparse_argv(tmp_path: Path, monkeypatch) -> None:
    """main(['--tui', ...]) must not let agent.tui parse sys.argv again."""
    monkeypatch.setenv("SESSION_DIR", str(tmp_path))
    monkeypatch.setenv("AGENT_LOG", "0")
    monkeypatch.setattr("agent.cli.load_local_env", lambda: None)
    monkeypatch.setattr(sys, "argv", ["main.py", "--tui", "--session", "x"])
    started: dict[str, str] = {}

    def fake_run(self: AgentApp) -> None:
        started["session"] = self.runner.session_id

    monkeypatch.setattr("agent.tui.AgentApp.run", fake_run)
    from agent.cli import main

    main(["--tui", "--session", "x"])
    assert started["session"] == "x"


def test_tui_module_still_parses_its_own_session(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("SESSION_DIR", str(tmp_path))
    monkeypatch.setenv("AGENT_LOG", "0")
    monkeypatch.setattr("agent.cli.load_local_env", lambda: None)
    monkeypatch.setattr(sys, "argv", ["agent.tui", "--session", "beta"])
    started: dict[str, str] = {}

    def fake_run(self: AgentApp) -> None:
        started["session"] = self.runner.session_id

    monkeypatch.setattr("agent.tui.AgentApp.run", fake_run)
    from agent.tui import run_tui

    run_tui()
    assert started["session"] == "beta"


def test_help_lists_tui_and_session() -> None:
    cli = subprocess.run(
        [sys.executable, "main.py", "--help"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    tui = subprocess.run(
        [sys.executable, "-m", "agent.tui", "--help"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert cli.returncode == 0
    assert "--tui" in cli.stdout
    assert "--session" in cli.stdout
    assert tui.returncode == 0
    assert "--session" in tui.stdout


def test_tui_message_tools_session_and_quit(tmp_path: Path) -> None:
    script = iter(
        [
            '<tool_call>{"name":"calculator","arguments":{"expression":"12*7"}}</tool_call>',
            "<answer>84</answer>",
        ]
    )

    def complete(_messages: list[dict[str, str]]) -> str:
        return next(script)

    runner = SessionRunner(
        session_id="alpha",
        session_dir=tmp_path,
        log_dir=None,
        complete_fn=complete,
    )
    runner.open()
    app = AgentApp(runner)

    async def drive() -> None:
        async with app.run_test(size=(110, 32)) as pilot:
            assert "alpha" in app.status_text
            await pilot.click("#tools")
            await app.workers.wait_for_complete()
            assert any(line.startswith("calculator:") for line in app.shown)
            app.query_one("#prompt").value = "what is 12*7"
            await pilot.click("#send")
            await app.workers.wait_for_complete()
            assert any("84" in line for line in app.shown)
            assert any("calculator" in line for line in app.trace_lines)
            await pilot.click("#new-session")
            await app.workers.wait_for_complete()
            assert app.runner.session_id != "alpha"
            assert "new" in app.status_text
            alpha = (tmp_path / "alpha.json").read_text(encoding="utf-8")
            assert "84" in alpha
            assert not (tmp_path / f"{app.runner.session_id}.json").exists()
            await pilot.click("#quit")

    import asyncio

    asyncio.run(drive())
