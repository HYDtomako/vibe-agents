"""Textual interface over the same session runner as the CLI."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from textual import work
from textual.app import App, ComposeResult
from textual.containers import Horizontal
from textual.widgets import Button, Header, Input, RichLog, Select, Static

from agent.cli import load_local_env
from agent.limits import env_flag
from agent.runtime import QUIT_COMMANDS, LineResult, SessionRunner, new_session_id
from llm.parse import parse_assistant
from sessions.store import SessionError, validate_session_id

BANNER = "Message, /tools, /session, or /quit"


class AgentApp(App[None]):
    """Message pane, trace summary, and session controls."""

    TITLE = "min-agent"
    CSS = """
    Screen { layout: vertical; }
    #status { height: 1; padding: 0 1; background: $boost; color: $text; }
    #trace-summary { height: 1; padding: 0 1; color: $text-muted; }
    #trace { height: 6; border: round $accent; margin: 0 1; padding: 0 1; }
    #transcript { height: 1fr; border: round $primary; margin: 0 1; padding: 0 1; }
    #composer { height: 3; padding: 0 1; }
    #prompt { width: 1fr; }
    #actions { height: auto; padding: 0 1 1 1; }
    Button { margin-right: 1; }
    #sessions { width: 28; }
    """

    def __init__(self, runner: SessionRunner) -> None:
        super().__init__()
        self.runner = runner
        self.shown: list[str] = []
        self.trace_lines: list[str] = []
        self.status_text = ""
        self._busy = False

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("", id="status")
        yield Static("trace: idle", id="trace-summary")
        yield RichLog(id="trace", wrap=True, markup=False, highlight=False)
        yield RichLog(id="transcript", wrap=True, markup=False, highlight=False)
        with Horizontal(id="composer"):
            yield Input(placeholder=BANNER, id="prompt")
        with Horizontal(id="actions"):
            yield Button("Send", id="send", variant="primary")
            yield Button("Tools", id="tools")
            yield Button("New session", id="new-session")
            yield Select([], prompt="Sessions", id="sessions", allow_blank=True)
            yield Button("Open", id="open-session")
            yield Button("Quit", id="quit", variant="error")

    def on_mount(self) -> None:
        self.query_one("#trace", RichLog).border_title = "Trace"
        self.query_one("#transcript", RichLog).border_title = "Messages"
        self._refresh_view()
        self.query_one("#prompt", Input).focus()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        event.input.value = ""
        self._submit(event.value)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        button_id = event.button.id
        if button_id == "quit":
            self.exit()
        elif button_id == "send":
            self._submit_from_input()
        elif button_id == "tools":
            self._submit("/tools")
        elif button_id == "new-session":
            self._submit("/session new")
        elif button_id == "open-session":
            value = self.query_one("#sessions", Select).value
            if value in (Select.NULL, Select.BLANK) or not isinstance(value, str):
                return
            self._submit(f"/session {value}")

    def _submit_from_input(self) -> None:
        prompt = self.query_one("#prompt", Input)
        text = prompt.value
        prompt.value = ""
        self._submit(text)

    def _submit(self, text: str) -> None:
        text = text.strip()
        if not text or self._busy:
            return
        if text in QUIT_COMMANDS:
            self.exit()
            return
        self._busy = True
        self._set_busy(True)
        self._run_line(text)

    @work(thread=True, exit_on_error=False)
    def _run_line(self, text: str) -> None:
        try:
            result = self.runner.handle(text)
        except Exception as exc:
            result = LineResult(lines=[f"[agent] {exc}"])
        self.call_from_thread(self._apply, result)

    def _apply(self, result: LineResult) -> None:
        self._busy = False
        self._set_busy(False)
        if result.quit:
            self.exit()
            return
        for entry in result.trace:
            self.trace_lines.append(entry)
            self.query_one("#trace", RichLog).write(entry)
        if self.trace_lines:
            self.query_one("#trace-summary", Static).update(f"trace: {self.trace_lines[-1]}")
        self._refresh_view()
        self.query_one("#prompt", Input).focus()

    def _refresh_view(self) -> None:
        self.status_text = self.runner.status_line()
        self.query_one("#status", Static).update(self.status_text)
        self.title = f"min-agent  {self.runner.session_id}"
        self.sub_title = self.runner.status_line()
        transcript = self.query_one("#transcript", RichLog)
        transcript.clear()
        self.shown = []
        for message in self.runner.store.history(self.runner.session_id):
            rendered = render_stored_message(message)
            if not rendered:
                continue
            transcript.write(rendered)
            self.shown.append(rendered)
        self._sync_select()

    def _sync_select(self) -> None:
        select = self.query_one("#sessions", Select)
        options = [(session_id, session_id) for session_id in self.runner.store.known_ids()]
        if self.runner.session_id not in {value for _label, value in options}:
            options.append((self.runner.session_id, self.runner.session_id))
        if not options:
            return
        select.set_options(options)
        select.value = self.runner.session_id

    def _set_busy(self, busy: bool) -> None:
        self.query_one("#prompt", Input).disabled = busy
        self.query_one("#send", Button).disabled = busy
        self.query_one("#tools", Button).disabled = busy
        self.query_one("#new-session", Button).disabled = busy
        self.query_one("#open-session", Button).disabled = busy
        self.query_one("#sessions", Select).disabled = busy


def render_stored_message(message: dict[str, str]) -> str:
    content = message.get("content", "")
    role = message.get("role", "")
    if content.startswith("[memory]\n"):
        detail = next((line for line in content.splitlines()[1:] if line.strip()), "[memory]")
        return f"memory: {detail}"
    if content.startswith("<tool_result") or content.startswith("Could not parse your reply"):
        return ""
    if role == "user":
        return f"you: {content}"
    parsed = parse_assistant(content)
    if parsed.answer and "<answer>" in content.lower():
        return f"agent: {parsed.answer}"
    return content


def run_tui(session_id: str | None = None, *, parse_args: bool = True) -> None:
    load_local_env()
    if parse_args:
        parser = argparse.ArgumentParser(prog="python -m agent.tui")
        parser.add_argument("--session", default="", help="Resume or create this session id")
        args = parser.parse_args()
        session_id = args.session or session_id or new_session_id()
    elif not session_id:
        session_id = new_session_id()
    try:
        session_id = validate_session_id(session_id)
    except ValueError as exc:
        print(f"[agent] {exc}")
        return
    session_dir = Path(os.environ.get("SESSION_DIR", "").strip() or "sessions/data")
    log_dir = None
    if env_flag("AGENT_LOG", True):
        log_dir = Path(os.environ.get("AGENT_LOG_DIR", "").strip() or "logs")
    runner = SessionRunner(session_id=session_id, session_dir=session_dir, log_dir=log_dir)
    try:
        runner.open()
    except (SessionError, ValueError) as exc:
        print(f"[agent] {exc}")
        return
    AgentApp(runner).run()


def main() -> None:
    run_tui()


if __name__ == "__main__":
    main()
