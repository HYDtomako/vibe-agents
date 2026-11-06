"""Agent loop tests with a scripted model. No live API calls."""

from __future__ import annotations

from agent.cli import run_cli
from agent.loop import run_turn
from tools import build_default_registry
from tools.todo import todo


def test_loop_executes_tool_then_returns_answer() -> None:
    seen: list[list[dict[str, str]]] = []

    def complete(messages: list[dict[str, str]]) -> str:
        seen.append(messages)
        if len(seen) == 1:
            return '<tool_call>{"name":"calculator","arguments":{"expression":"12*7"}}</tool_call>'
        return "<answer>84</answer>"

    registry = build_default_registry()
    result = run_turn(
        "what is 12*7",
        session_id="math",
        history=[{"role": "user", "content": "earlier"}, {"role": "assistant", "content": "noted"}],
        registry=registry,
        complete_fn=complete,
        max_steps=6,
    )

    assert result.answer == "84"
    assert result.error == ""
    assert any("tool calculator" in entry for entry in result.trace)
    system = seen[0][0]["content"]
    assert seen[0][0]["role"] == "system"
    assert "<tool_call>" in system
    assert "<answer>" in system
    assert "calculator" in system
    assert seen[0][1]["content"] == "earlier"
    assert seen[0][-1] == {"role": "user", "content": "what is 12*7"}
    assert "84" in seen[1][-1]["content"]
    assert "<tool_result" in seen[1][-1]["content"]


def test_loop_records_tool_failure_and_still_answers() -> None:
    seen: list[str] = []

    def complete(messages: list[dict[str, str]]) -> str:
        seen.append(messages[-1]["content"])
        if len(seen) == 1:
            return '<tool_call>{"name":"calculator","arguments":{"expression":"1/0"}}</tool_call>'
        return "<answer>cannot divide by zero</answer>"

    result = run_turn(
        "divide",
        session_id="math",
        history=[],
        registry=build_default_registry(),
        complete_fn=complete,
        max_steps=4,
    )
    assert "division by zero" in seen[1]
    assert result.answer == "cannot divide by zero"
    assert any("failed" in entry for entry in result.trace)


def test_loop_stops_at_max_steps() -> None:
    def complete(_messages: list[dict[str, str]]) -> str:
        return '<tool_call>{"name":"calculator","arguments":{"expression":"1+1"}}</tool_call>'

    result = run_turn(
        "loop",
        session_id="s",
        history=[],
        registry=build_default_registry(),
        complete_fn=complete,
        max_steps=2,
    )
    assert result.answer == ""
    assert result.error == "stopped after 2 steps without an answer"


def test_loop_todo_uses_session_id() -> None:
    calls = {"n": 0}

    def complete(_messages: list[dict[str, str]]) -> str:
        calls["n"] += 1
        if calls["n"] == 1:
            return '<tool_call>{"name":"todo","arguments":{"action":"add","text":"buy milk"}}</tool_call>'
        return "<answer>added milk</answer>"

    result = run_turn(
        "remember milk",
        session_id="desk",
        history=[],
        registry=build_default_registry(),
        complete_fn=complete,
    )
    assert result.answer == "added milk"
    items = todo("list", "desk")["items"]
    assert items == [{"id": 1, "text": "buy milk", "done": False}]
    assert todo("list", "other")["items"] == []


def test_cli_sentence_triggers_tool_and_prints_answer() -> None:
    replies = iter(
        [
            '<tool_call>{"name":"calculator","arguments":{"expression":"12*7"}}</tool_call>',
            "<answer>84</answer>",
        ]
    )
    lines: list[str] = []
    traces: list[str] = []
    answers = iter(["math", "what is 12*7", "/quit"])
    run_cli(
        input_fn=lambda _prompt: next(answers),
        output_fn=lines.append,
        complete_fn=lambda _messages: next(replies),
        trace_fn=traces.append,
    )
    assert "84" in lines
    assert not any(line.startswith("[stub]") for line in lines)
    assert any("tool calculator" in entry for entry in traces)
    assert lines[-1] == "bye"


def test_cli_api_error_is_readable(monkeypatch) -> None:
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    lines: list[str] = []
    answers = iter(["s", "hello", "/quit"])
    run_cli(input_fn=lambda _prompt: next(answers), output_fn=lines.append)
    assert "[agent] DEEPSEEK_API_KEY is unset" in lines
    assert lines[-1] == "bye"
