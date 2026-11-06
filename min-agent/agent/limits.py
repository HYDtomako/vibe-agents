"""Environment limits for the agent loop. Empty values use the defaults."""

from __future__ import annotations

import os

DEFAULT_MAX_STEPS = 8
DEFAULT_MAX_TURNS = 40
DEFAULT_MAX_MESSAGES = 200
DEFAULT_RECENT_TURNS = 6
DEFAULT_COMPRESS_CHARS = 6000


def env_int(name: str, default: int, override: int | None = None) -> int:
    if override is not None:
        return max(1, override)
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


def env_flag(name: str, default: bool = True) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    if raw in {"0", "false", "no", "off"}:
        return False
    if raw in {"1", "true", "yes", "on"}:
        return True
    return default
