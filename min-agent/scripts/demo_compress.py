"""Print a real conversation before compression, after it, and on the next request.

No network. From min-agent/:

    python scripts/demo_compress.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agent.loop import run_turn
from sessions.compress import compress_history
from tools import build_default_registry

MAX_CHARS = 200
KEEP_TURNS = 2


def sample_history() -> list[dict[str, str]]:
    """Four spoken turns. The first two are old enough to fall into [memory]."""
    return [
        {
            "role": "user",
            "content": "我下周去上海出差，先帮我看一下上海天气，阴的话我得带伞。",
        },
        {
            "role": "assistant",
            "content": "<answer>上海这场是模拟预报，18度，多云。你可以按带伞来准备。</answer>",
        },
        {
            "role": "user",
            "content": "再记两条待办：订虹桥附近的酒店，周五给客户带一盒蝴蝶酥。",
        },
        {
            "role": "assistant",
            "content": "<answer>记下了。一是订虹桥附近的酒店，二是周五带蝴蝶酥给客户。</answer>",
        },
        {
            "role": "user",
            "content": "晚饭改到今晚七点，在静安寺见面。",
        },
        {
            "role": "assistant",
            "content": "<answer>好，今晚七点，静安寺吃晚饭。</answer>",
        },
        {
            "role": "user",
            "content": "账单 286 块，按 15% 算一下小费。",
        },
        {
            "role": "assistant",
            "content": "<answer>286 的 15% 是 42.9，小费大约 43 块。</answer>",
        },
    ]


def _show(title: str, messages: list[dict[str, str]]) -> None:
    print(f"\n== {title} ==")
    for index, message in enumerate(messages):
        content = message.get("content", "")
        role = message.get("role", "")
        if role == "system":
            head = content.splitlines()[0]
            print(f"[{index}] system: {head} …（后接循环说明与工具 schema，共 {len(content)} 字符）")
            continue
        print(f"[{index}] {role}: {content}")


def main() -> None:
    history = sample_history()
    compressed, changed = compress_history(history, max_chars=MAX_CHARS, keep_turns=KEEP_TURNS)
    seen: list[list[dict[str, str]]] = []

    def complete(messages: list[dict[str, str]]) -> str:
        seen.append(messages)
        return "<answer>上海那场模拟预报是 18 度。</answer>"

    run_turn(
        "刚才上海多少度来着？",
        session_id="demo",
        history=history,
        registry=build_default_registry(),
        complete_fn=complete,
        compress_chars=MAX_CHARS,
        recent_turns=KEEP_TURNS,
    )
    chars = sum(len(item["content"]) for item in history)
    _show("压缩前", history)
    print(f"\n字符数 {chars}，阈值 {MAX_CHARS}，保留最近 {KEEP_TURNS} 轮，发生压缩: {changed}")
    _show("压缩后（前两轮收进 [memory]，晚饭和小费原文还在）", compressed)
    _show("下次请求", seen[0])
    blob = json.dumps(seen[0], ensure_ascii=False)
    memory = compressed[0]["content"]
    print("\n核对:")
    print(f"  旧轮「带伞 / 蝴蝶酥」进了 [memory]: {'带伞' in memory and '蝴蝶酥' in memory}")
    print(f"  最近轮「静安寺 / 小费」仍是原文: {'静安寺' in blob and '小费' in blob and '静安寺' not in memory}")
    print(f"  新问题在请求末尾: {seen[0][-1]['content'] == '刚才上海多少度来着？'}")


if __name__ == "__main__":
    main()
