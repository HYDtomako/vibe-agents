"""Registry and per-tool tests for module 2."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from tools.calculator import calculate
from tools.registry import Tool, ToolRegistry, UnknownToolError, build_default_registry, object_schema
from tools.search import search
from tools.todo import todo
from tools.weather import weather

ROOT = Path(__file__).resolve().parents[1]


def test_env_example_uses_flash_and_empty_secrets() -> None:
    lines = (ROOT / ".env.example").read_text(encoding="utf-8").splitlines()
    values = dict(line.split("=", 1) for line in lines if "=" in line)
    assert values["DEEPSEEK_API_KEY"] == ""
    assert values["DEEPSEEK_MODEL"] == "deepseek-flash"
    assert values["WEATHER_API_KEY"] == ""
    assert "deepseek-chat" not in lines


def test_register_list_schemas_and_call() -> None:
    registry = ToolRegistry()
    registry.register(
        Tool(
            name="echo",
            description="Echo text.",
            parameters=object_schema(
                {"text": {"type": "string"}},
                ["text"],
            ),
            handler=lambda text: {"text": text},
        )
    )
    with pytest.raises(ValueError, match="already registered"):
        registry.register(
            Tool(
                name="echo",
                description="again",
                parameters=object_schema({}, []),
                handler=lambda: None,
            )
        )

    schemas = registry.list_schemas()
    json.dumps(schemas)
    assert schemas == [
        {
            "type": "function",
            "function": {
                "name": "echo",
                "description": "Echo text.",
                "parameters": object_schema({"text": {"type": "string"}}, ["text"]),
            },
        }
    ]
    assert "handler" not in schemas[0]["function"]
    assert registry.call("echo", {"text": "hi"}) == {"text": "hi"}
    with pytest.raises(UnknownToolError, match="unknown tool: missing"):
        registry.call("missing", {})


def test_default_registry_calls_calculator() -> None:
    registry = build_default_registry()
    assert registry.names() == ["calculator", "search", "todo", "weather"]
    assert registry.call("calculator", {"expression": "2+3*4"})["result"] == 14
    with pytest.raises(ValueError, match="missing arguments"):
        registry.call("calculator", {})


def test_calculator_arithmetic_and_rejects_python() -> None:
    assert calculate("(2 + 3) * 4")["result"] == 20
    assert calculate("7 // 2")["result"] == 3
    assert calculate("-3 + 5")["result"] == 2
    assert calculate("3.5 * 2")["result"] == 7.0
    for expression in (
        "__import__('os')",
        "os.system('id')",
        "(lambda: 1)()",
        "a.b",
        "",
        "2 ** 100",
    ):
        with pytest.raises(ValueError):
            calculate(expression)
    with pytest.raises(ValueError, match="division by zero"):
        calculate("1 / 0")
    source = (ROOT / "tools" / "calculator.py").read_text(encoding="utf-8")
    assert "eval(" not in source
    assert "exec(" not in source


def test_search_is_local_mock() -> None:
    hit = search("calculator")
    assert hit["source"] == "mock"
    assert hit["results"][0]["title"] == "Calculator notes"
    unknown = search("zephyr", limit="1")
    assert unknown["results"] == [
        {
            "title": "Mock result for zephyr",
            "snippet": "Local fake search. No web request was made.",
        }
    ]
    with pytest.raises(ValueError, match="limit"):
        search("todo", limit="9")


def test_todo_is_per_session() -> None:
    first = todo("add", "s1", text="buy milk")
    todo("add", "s2", text="other session")
    assert [item["text"] for item in first["items"]] == ["buy milk"]
    listed = todo("list", "s1")
    assert listed["items"][0]["id"] == 1
    done = todo("done", "s1", item_id="1")
    assert done["items"][0]["done"] is True
    removed = todo("remove", "s1", item_id=1)
    assert removed["items"] == []
    assert [item["text"] for item in todo("list", "s2")["items"]] == ["other session"]
    with pytest.raises(ValueError, match="session_id"):
        build_default_registry().call("todo", {"action": "list"})


def test_weather_mock_without_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WEATHER_API_KEY", raising=False)

    def explode(*_args, **_kwargs):
        raise AssertionError("network used")

    monkeypatch.setattr("tools.weather.urllib.request.urlopen", explode)
    result = weather("Lisbon")
    assert result["source"] == "mock"
    assert result["city"] == "Lisbon"
    assert result["summary"] == "Mock weather for Lisbon: 18°C, partly cloudy."
    assert result["note"] == "WEATHER_API_KEY is unset"


def test_weather_uses_api_when_key_is_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEATHER_API_KEY", "test-key")
    payload = json.dumps(
        {
            "name": "Lisbon",
            "weather": [{"description": "clear sky"}],
            "main": {"temp": 21.5},
        }
    ).encode()

    class _Body:
        def read(self) -> bytes:
            return payload

        def __enter__(self) -> _Body:
            return self

        def __exit__(self, *_args) -> bool:
            return False

    monkeypatch.setattr("tools.weather.urllib.request.urlopen", lambda *_a, **_k: _Body())
    result = weather("Lisbon")
    assert result["source"] == "openweathermap"
    assert result["temp_c"] == 21.5
    assert "clear sky" in result["summary"]


def test_weather_request_failure_is_mock_and_hides_key(monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "super-secret-key"
    monkeypatch.setenv("WEATHER_API_KEY", secret)

    def explode(*_args, **_kwargs):
        raise urllib.error.URLError(f"failed https://api.example?appid={secret}")

    monkeypatch.setattr(urllib.request, "urlopen", explode)
    result = weather("Lisbon")
    assert result["source"] == "mock"
    assert result["note"] == "weather request failed"
    assert secret not in json.dumps(result)
