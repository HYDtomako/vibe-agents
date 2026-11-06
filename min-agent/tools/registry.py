"""In-process tool registry. Schemas are JSON-serializable for a later model call."""

from __future__ import annotations

import inspect
from collections.abc import Callable
from typing import Any

Handler = Callable[..., Any]


class UnknownToolError(Exception):
    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(f"unknown tool: {name}")


class Tool:
    def __init__(
        self,
        name: str,
        description: str,
        parameters: dict[str, Any],
        handler: Handler,
    ) -> None:
        self.name = name
        self.description = description
        self.parameters = parameters
        self.handler = handler


def object_schema(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        if tool.name in self._tools:
            raise ValueError(f"tool already registered: {tool.name}")
        self._tools[tool.name] = tool

    def names(self) -> list[str]:
        return list(self._tools)

    def list_schemas(self) -> list[dict[str, Any]]:
        """Function schemas a chat model can take as its tools list."""
        return [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                },
            }
            for tool in self._tools.values()
        ]

    def call(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        *,
        session_id: str | None = None,
    ) -> Any:
        try:
            tool = self._tools[name]
        except KeyError as exc:
            raise UnknownToolError(name) from exc
        args = dict(arguments or {})
        _validate(tool, args)
        if _accepts_session_id(tool.handler):
            if not session_id:
                raise ValueError("session_id is required")
            args["session_id"] = session_id
        return tool.handler(**args)


def _accepts_session_id(handler: Handler) -> bool:
    return "session_id" in inspect.signature(handler).parameters


def _validate(tool: Tool, arguments: dict[str, Any]) -> None:
    schema = tool.parameters
    properties = schema.get("properties", {})
    required = schema.get("required", [])
    missing = [key for key in required if arguments.get(key) in (None, "")]
    if missing:
        raise ValueError(f"missing arguments: {', '.join(missing)}")
    if schema.get("additionalProperties") is False:
        extra = [key for key in arguments if key not in properties]
        if extra:
            raise ValueError(f"unexpected arguments: {', '.join(extra)}")


def build_default_registry() -> ToolRegistry:
    from tools.calculator import CALCULATOR
    from tools.search import SEARCH
    from tools.todo import TODO
    from tools.weather import WEATHER

    registry = ToolRegistry()
    for tool in (CALCULATOR, SEARCH, TODO, WEATHER):
        registry.register(tool)
    return registry
