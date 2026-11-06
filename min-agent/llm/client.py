"""Thin OpenAI-compatible chat client. The API key comes from the environment."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

Transport = Callable[[str, dict[str, str], bytes, float], tuple[int, bytes]]

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-flash"


class MissingApiKeyError(RuntimeError):
    """Raised when a chat call is attempted without DEEPSEEK_API_KEY."""


class ChatError(RuntimeError):
    """Raised when the chat endpoint fails or returns an unexpected body."""


@dataclass(frozen=True)
class ChatSettings:
    api_key: str
    base_url: str
    model: str


def load_settings(environ: Mapping[str, str] | None = None) -> ChatSettings:
    env = os.environ if environ is None else environ
    return ChatSettings(
        api_key=env.get("DEEPSEEK_API_KEY", "").strip(),
        base_url=(env.get("DEEPSEEK_BASE_URL", "").strip() or DEFAULT_BASE_URL).rstrip("/"),
        model=env.get("DEEPSEEK_MODEL", "").strip() or DEFAULT_MODEL,
    )


def urllib_transport(url: str, headers: dict[str, str], body: bytes, timeout: float) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


class ChatClient:
    def __init__(
        self,
        settings: ChatSettings | None = None,
        transport: Transport | None = None,
        timeout: float = 30,
    ) -> None:
        self.settings = settings if settings is not None else load_settings()
        self._transport = transport or urllib_transport
        self._timeout = timeout

    def complete(self, messages: list[dict[str, str]]) -> str:
        if not self.settings.api_key:
            raise MissingApiKeyError("DEEPSEEK_API_KEY is unset")
        url = f"{self.settings.base_url}/chat/completions"
        payload = {"model": self.settings.model, "messages": messages}
        body = json.dumps(payload).encode("utf-8")
        headers = {
            "Authorization": f"Bearer {self.settings.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        try:
            status, raw = self._transport(url, headers, body, self._timeout)
        except (urllib.error.URLError, TimeoutError) as exc:
            raise ChatError("chat request failed") from exc
        return _message_text(status, raw, self.settings.api_key)


def _message_text(status: int, raw: bytes, api_key: str) -> str:
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        if status >= 400:
            raise ChatError(f"chat request failed ({status})") from exc
        raise ChatError("chat response was not JSON") from exc
    if status >= 400 or not isinstance(payload, dict):
        raise ChatError(_error_text(payload, status, api_key))
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ChatError("chat response did not include a message") from exc
    if content is None:
        return ""
    if not isinstance(content, str):
        raise ChatError("chat response content was not text")
    return content


def _error_text(payload: Any, status: int, api_key: str) -> str:
    message = ""
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            message = error["message"]
        elif isinstance(payload.get("message"), str):
            message = payload["message"]
    if not message:
        message = f"chat request failed ({status})"
    if api_key and api_key in message:
        message = message.replace(api_key, "[redacted]")
    return message
