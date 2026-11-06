import pytest

_LIMIT_ENV = (
    "AGENT_MAX_STEPS",
    "AGENT_MAX_TURNS",
    "AGENT_MAX_MESSAGES",
    "AGENT_RECENT_TURNS",
    "AGENT_COMPRESS_CHARS",
    "AGENT_LOG",
    "AGENT_LOG_DIR",
    "SESSION_DIR",
)


@pytest.fixture(autouse=True)
def _stable_limit_env(monkeypatch: pytest.MonkeyPatch):
    for name in _LIMIT_ENV:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(autouse=True)
def _reset_todo_store():
    from tools.todo import clear_todos

    clear_todos()
    yield
    clear_todos()
