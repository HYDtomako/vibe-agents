"""Parser and chat-client tests. No live API calls."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from llm.client import ChatClient, ChatError, ChatSettings, MissingApiKeyError, load_settings
from llm.parse import ToolCall, parse_assistant

ROOT = Path(__file__).resolve().parents[1]

FULL = """
<think>
2+2 is four
</think>
<tool_call>{"name":"calculator","arguments":{"expression":"2+2"}}</tool_call>
<answer>
4
</answer>
"""


def test_parse_think_tool_and_answer() -> None:
    parsed = parse_assistant(FULL)
    assert parsed.thinking == "2+2 is four"
    assert parsed.tool_calls == (ToolCall("calculator", {"expression": "2+2"}),)
    assert parsed.answer == "4"
    assert parsed.notes == ()


def test_parse_multiple_tool_calls_and_missing_think() -> None:
    raw = """
<tool_call>{"name":"search","arguments":{"query":"milk"}}</tool_call>
<tool_call>{"name":"todo","arguments":{"action":"list"}}</tool_call>
<answer>listed</answer>
"""
    parsed = parse_assistant(raw)
    assert parsed.thinking == ""
    assert [call.name for call in parsed.tool_calls] == ["search", "todo"]
    assert parsed.tool_calls[1].arguments == {"action": "list"}
    assert parsed.answer == "listed"


def test_parse_missing_sections_and_invalid_tool_json() -> None:
    assert parse_assistant("") == parse_assistant("no tags here")
    empty = parse_assistant("")
    assert empty.thinking == ""
    assert empty.tool_calls == ()
    assert empty.answer == ""
    assert empty.notes == ()

    mixed = """
<tool_call>{not json}</tool_call>
<tool_call>{"name":"calculator","arguments":{"expression":"1+1"}}</tool_call>
<tool_call>{"name":"search"}</tool_call>
<answer>ok</answer>
"""
    parsed = parse_assistant(mixed)
    assert parsed.thinking == ""
    assert [call.name for call in parsed.tool_calls] == ["calculator", "search"]
    assert parsed.tool_calls[1].arguments == {}
    assert parsed.answer == "ok"
    assert parsed.notes == ("skipped tool_call 1: invalid JSON",)

    bad_args = parse_assistant('<tool_call>{"name":"calculator","arguments":"1+1"}</tool_call>')
    assert bad_args.tool_calls == ()
    assert bad_args.notes == ("skipped tool_call 1: arguments must be a JSON object",)
    assert "unclosed <think>" in parse_assistant("<think>still going").notes


def test_schema_doc_uses_the_same_tags() -> None:
    doc = (ROOT / "llm" / "schema.md").read_text(encoding="utf-8")
    assert "<think>" in doc
    assert "<tool_call>" in doc
    assert "<answer>" in doc
    assert '"name":"calculator"' in doc or '"name": "calculator"' in doc


def test_load_settings_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_BASE_URL", raising=False)
    monkeypatch.delenv("DEEPSEEK_MODEL", raising=False)
    settings = load_settings()
    assert settings.api_key == ""
    assert settings.base_url == "https://api.deepseek.com"
    assert settings.model == "deepseek-flash"


def test_complete_posts_chat_and_redacts_key() -> None:
    secret = "test-secret-key"
    seen: dict[str, object] = {}

    def transport(url: str, headers: dict[str, str], body: bytes, timeout: float):
        seen["url"] = url
        seen["headers"] = headers
        seen["body"] = json.loads(body)
        seen["timeout"] = timeout
        payload = {"choices": [{"message": {"content": "<answer>ok</answer>"}}]}
        return 200, json.dumps(payload).encode()

    client = ChatClient(
        ChatSettings(api_key=secret, base_url="https://example.test/v1", model="deepseek-flash"),
        transport=transport,
    )
    assert client.complete([{"role": "user", "content": "hi"}]) == "<answer>ok</answer>"
    assert seen["url"] == "https://example.test/v1/chat/completions"
    assert seen["headers"]["Authorization"] == f"Bearer {secret}"
    assert secret not in str(seen["url"])
    assert seen["body"]["model"] == "deepseek-flash"

    def forbidden(url: str, headers: dict[str, str], body: bytes, timeout: float):
        payload = {"error": {"message": f"rejected {secret}"}}
        return 401, json.dumps(payload).encode()

    failing = ChatClient(
        ChatSettings(api_key=secret, base_url="https://example.test", model="deepseek-flash"),
        transport=forbidden,
    )
    with pytest.raises(ChatError, match="rejected \\[redacted\\]") as raised:
        failing.complete([{"role": "user", "content": "hi"}])
    assert secret not in str(raised.value)


def test_missing_key_does_not_call_transport() -> None:
    def transport(*_args, **_kwargs):
        raise AssertionError("network used")

    client = ChatClient(
        ChatSettings(api_key="", base_url="https://api.deepseek.com", model="deepseek-flash"),
        transport=transport,
    )
    with pytest.raises(MissingApiKeyError, match="DEEPSEEK_API_KEY is unset"):
        client.complete([{"role": "user", "content": "hi"}])


