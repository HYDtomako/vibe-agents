"""The interview compression demo prints a readable conversation."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_demo_compress_script_prints_a_real_conversation() -> None:
    proc = subprocess.run(
        [sys.executable, "scripts/demo_compress.py"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    out = proc.stdout
    assert "[memory]" in out
    assert "旧轮「带伞 / 蝴蝶酥」进了 [memory]: True" in out
    assert "最近轮「静安寺 / 小费」仍是原文: True" in out
    assert "新问题在请求末尾: True" in out
    assert "刚才上海多少度来着？" in out
    assert "工具 schema" in out
    for filler in ("OLDTOKEN", "TAILMARKER", "RECENT-A", "RECENT-B", "xxxxx", "甲甲甲"):
        assert filler not in out
