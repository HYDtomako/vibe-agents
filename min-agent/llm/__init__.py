"""Chat client and the tagged assistant-message parser."""

from llm.client import ChatClient, ChatError, ChatSettings, MissingApiKeyError, load_settings
from llm.parse import FORMAT_RULES, ParsedMessage, ToolCall, format_parsed, parse_assistant, system_prompt

__all__ = [
    "FORMAT_RULES",
    "ChatClient",
    "ChatError",
    "ChatSettings",
    "MissingApiKeyError",
    "ParsedMessage",
    "ToolCall",
    "format_parsed",
    "load_settings",
    "parse_assistant",
    "system_prompt",
]
