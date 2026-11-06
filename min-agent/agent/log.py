"""Session trace files. Secret env values are redacted before anything is written."""

from __future__ import annotations

import os
from pathlib import Path

_SECRET_ENV = ("DEEPSEEK_API_KEY", "WEATHER_API_KEY")


def redact(text: str) -> str:
    for name in _SECRET_ENV:
        secret = os.environ.get(name, "")
        if len(secret) >= 8:
            text = text.replace(secret, "[redacted]")
    return text


def append_log(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(redact(text).rstrip() + "\n")
