"""Local fake search. Nothing here contacts the network."""

from __future__ import annotations

from typing import Any

from tools.registry import Tool, object_schema

_CATALOG = (
    {
        "title": "Calculator notes",
        "snippet": "Arithmetic uses an AST whitelist of numbers and operators.",
    },
    {
        "title": "Todo list",
        "snippet": "Todos are kept per session in an in-memory dict.",
    },
    {
        "title": "Weather mock",
        "snippet": "Weather returns a mock forecast when WEATHER_API_KEY is unset.",
    },
    {
        "title": "Min-agent CLI",
        "snippet": "A normal sentence can ask the agent to run a registered tool.",
    },
)


def search(query: str, limit: int | str = 3) -> dict[str, Any]:
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query is required")
    size = _limit(limit)
    needle = query.strip().lower()
    hits = [
        item
        for item in _CATALOG
        if needle in item["title"].lower() or needle in item["snippet"].lower()
    ]
    if not hits:
        hits = [
            {
                "title": f"Mock result for {query.strip()}",
                "snippet": "Local fake search. No web request was made.",
            }
        ]
    return {
        "query": query.strip(),
        "source": "mock",
        "results": [dict(item) for item in hits[:size]],
    }


def _limit(limit: int | str) -> int:
    if isinstance(limit, bool) or limit is None:
        raise ValueError("limit must be an integer")
    if isinstance(limit, str):
        if not limit.strip().isdigit():
            raise ValueError("limit must be an integer")
        limit = int(limit)
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise ValueError("limit must be an integer")
    if limit < 1 or limit > 5:
        raise ValueError("limit must be from 1 to 5")
    return limit


SEARCH = Tool(
    name="search",
    description="Search a fixed local index and return mock results. Does not use the network.",
    parameters=object_schema(
        {
            "query": {"type": "string", "description": "Text to match against the local index."},
            "limit": {
                "type": "integer",
                "description": "Maximum results, from 1 to 5. Defaults to 3.",
            },
        },
        ["query"],
    ),
    handler=search,
)
