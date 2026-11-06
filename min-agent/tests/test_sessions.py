"""Session files, caps, compression, and /session switching."""

from __future__ import annotations

import json
from pathlib import Path

from agent.cli import run_cli
from agent.log import append_log
from agent.loop import run_turn
from sessions.compress import compress_history
from sessions.store import SessionStore
from tools import build_default_registry
from tools.todo import export_todos, replace_todos


def test_two_session_files_keep_separate_history_and_todos(tmp_path: Path) -> None:
    store = SessionStore(tmp_path)
    store.load("alpha")
    store.append("alpha", "user", "only alpha")
    store.set_todos("alpha", [{"id": 1, "text": "alpha milk", "done": False}])
    store.save("alpha")
    store.load("beta")
    store.append("beta", "user", "only beta")
    store.set_todos("beta", [{"id": 1, "text": "beta bread", "done": False}])
    store.save("beta")

    fresh = SessionStore(tmp_path)
    assert fresh.load("alpha") is True
    assert fresh.load("beta") is True
    assert [item["content"] for item in fresh.history("alpha")] == ["only alpha"]
    assert [item["content"] for item in fresh.history("beta")] == ["only beta"]
    assert fresh.get_todos("alpha")[0]["text"] == "alpha milk"
    assert fresh.get_todos("beta")[0]["text"] == "beta bread"
    replace_todos("alpha", fresh.get_todos("alpha"))
    replace_todos("beta", fresh.get_todos("beta"))
    assert export_todos("alpha")[0]["text"] == "alpha milk"
    assert export_todos("beta")[0]["text"] == "beta bread"


def test_resume_reloads_saved_history(tmp_path: Path) -> None:
    store = SessionStore(tmp_path)
    store.load("alpha")
    store.replace(
        "alpha",
        [
            {"role": "user", "content": "codename PLUM"},
            {"role": "assistant", "content": "<answer>noted</answer>"},
        ],
        new_user_turn=True,
    )
    store.save("alpha")

    fresh = SessionStore(tmp_path)
    assert fresh.load("alpha") is True
    assert fresh.user_turns("alpha") == 1
    assert fresh.history("alpha")[0]["content"] == "codename PLUM"


def test_compress_keeps_recent_turns_and_summarizes_the_rest() -> None:
    history: list[dict[str, str]] = []
    for index in range(4):
        if index == 0:
            user = "OLDTOKEN " + ("x" * 90) + " TAILMARKER"
        else:
            user = f"question {index}"
        history.append({"role": "user", "content": user})
        history.append({"role": "assistant", "content": f"answer {index} " + ("y" * 40)})

    compressed, changed = compress_history(history, max_chars=200, keep_turns=2)
    assert changed is True
    assert compressed[0]["content"].startswith("[memory]\n")
    assert "OLDTOKEN" in compressed[0]["content"]
    assert "TAILMARKER" not in compressed[0]["content"]
    recent = json.dumps(compressed[1:])
    assert "TAILMARKER" not in recent
    assert "question 3" in recent
    assert "answer 3" in recent

    seen: list[list[dict[str, str]]] = []

    def complete(messages: list[dict[str, str]]) -> str:
        seen.append(messages)
        return "<answer>done</answer>"

    result = run_turn(
        "latest question",
        session_id="s",
        history=history,
        registry=build_default_registry(),
        complete_fn=complete,
        compress_chars=200,
        recent_turns=2,
    )
    request = json.dumps(seen[0])
    assert "[memory]" in request
    assert "TAILMARKER" not in request
    assert "latest question" in request
    assert result.messages[1]["content"].startswith("[memory]\n")
    assert any("compressed older turns" in entry for entry in result.trace)


def test_turn_cap_does_not_change_the_file(tmp_path: Path) -> None:
    store = SessionStore(tmp_path)
    store.load("cap")
    store.replace(
        "cap",
        [
            {"role": "user", "content": "one"},
            {"role": "assistant", "content": "<answer>a</answer>"},
        ],
        new_user_turn=True,
    )
    store.save("cap")
    before = (tmp_path / "cap.json").read_bytes()

    def complete(_messages: list[dict[str, str]]) -> str:
        raise AssertionError("model called after the cap")

    lines: list[str] = []
    answers = iter(["another", "/quit"])
    run_cli(
        input_fn=lambda _prompt: next(answers),
        output_fn=lines.append,
        complete_fn=complete,
        session_id="cap",
        session_dir=tmp_path,
        max_turns=1,
    )
    assert any("AGENT_MAX_TURNS=1" in line and "was not changed" in line for line in lines)
    assert (tmp_path / "cap.json").read_bytes() == before


def test_corrupt_session_file_is_not_overwritten(tmp_path: Path) -> None:
    path = tmp_path / "bad.json"
    path.write_text("{nope", encoding="utf-8")
    lines: list[str] = []
    run_cli(
        input_fn=lambda _prompt: (_ for _ in ()).throw(AssertionError("prompted")),
        output_fn=lines.append,
        session_id="bad",
        session_dir=tmp_path,
    )
    assert path.read_text(encoding="utf-8") == "{nope"
    assert any("was not changed" in line for line in lines)


def test_cli_session_switch_isolates_history_and_todos(tmp_path: Path) -> None:
    script = iter(
        [
            '<tool_call>{"name":"todo","arguments":{"action":"add","text":"alpha milk"}}</tool_call>',
            "<answer>added alpha</answer>",
            "<answer>beta ready</answer>",
            '<tool_call>{"name":"todo","arguments":{"action":"list"}}</tool_call>',
            "<answer>listed</answer>",
        ]
    )
    seen: list[str] = []

    def complete(messages: list[dict[str, str]]) -> str:
        seen.append(messages[-1]["content"])
        return next(script)

    lines: list[str] = []
    answers = iter(
        [
            "remember alpha milk",
            "/session",
            "/session new",
            "hello from beta",
            "/session alpha",
            "what is on my list",
            "/quit",
        ]
    )
    run_cli(
        input_fn=lambda _prompt: next(answers),
        output_fn=lines.append,
        complete_fn=complete,
        session_id="alpha",
        session_dir=tmp_path,
    )
    assert "session: alpha" in lines
    assert "added alpha" in lines
    assert "beta ready" in lines
    new_line = next(line for line in lines if "(new, 0 messages)" in line and "alpha" not in line)
    beta_id = new_line.split()[1]
    assert any(line.startswith("session: alpha (resumed,") for line in lines)
    assert "alpha milk" in seen[-1]

    alpha = SessionStore(tmp_path)
    alpha.load("alpha")
    beta = SessionStore(tmp_path)
    beta.load(beta_id)
    alpha_blob = json.dumps({"messages": alpha.history("alpha"), "todos": alpha.get_todos("alpha")})
    beta_blob = json.dumps({"messages": beta.history(beta_id), "todos": beta.get_todos(beta_id)})
    assert "alpha milk" in alpha_blob
    assert "hello from beta" not in alpha_blob
    assert "hello from beta" in beta_blob
    assert "alpha milk" not in beta_blob


def test_slash_words_are_ordinary_sentences(tmp_path: Path) -> None:
    seen: list[str] = []

    def complete(messages: list[dict[str, str]]) -> str:
        seen.append(messages[-1]["content"])
        return "<answer>ok</answer>"

    lines: list[str] = []
    answers = iter(["/ask hello", "/call calculator expression=1+1", "/quit"])
    run_cli(
        input_fn=lambda _prompt: next(answers),
        output_fn=lines.append,
        complete_fn=complete,
        session_id="s",
        session_dir=tmp_path,
    )
    assert seen == ["/ask hello", "/call calculator expression=1+1"]
    assert lines.count("ok") == 2
    assert not any("usage:" in line for line in lines)


def test_loaded_memory_is_included_in_the_next_request(tmp_path: Path) -> None:
    store = SessionStore(tmp_path)
    store.load("alpha")
    store.replace(
        "alpha",
        [
            {
                "role": "user",
                "content": "[memory]\nSummary of earlier turns:\n- user: ancient fact",
            },
            {"role": "user", "content": "recent question"},
            {"role": "assistant", "content": "<answer>recent answer</answer>"},
        ],
        new_user_turn=True,
    )
    store.save("alpha")
    seen: list[list[dict[str, str]]] = []

    def complete(messages: list[dict[str, str]]) -> str:
        seen.append(messages)
        return "<answer>ok</answer>"

    answers = iter(["follow up", "/quit"])
    run_cli(
        input_fn=lambda _prompt: next(answers),
        output_fn=lambda _text: None,
        complete_fn=complete,
        session_id="alpha",
        session_dir=tmp_path,
        log_dir=None,
    )
    request = json.dumps(seen[0])
    assert seen[0][0]["role"] == "system"
    assert "[memory]" in request
    assert "ancient fact" in request
    assert "follow up" in request


def test_log_redacts_api_key(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "super-secret-key")
    path = tmp_path / "s.log"
    append_log(path, "failed with super-secret-key")
    text = path.read_text(encoding="utf-8")
    assert "super-secret-key" not in text
    assert "[redacted]" in text
