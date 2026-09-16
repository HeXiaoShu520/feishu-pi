#! {"name":"memory","description":"团队长期记忆：action=read 查看全部记忆；action=append 且传 text 时追加一条要点（一句话）。用户交代需要长期记住的事实/偏好/约定时使用。","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["read","append"],"description":"read=查看全部记忆，append=追加一条"},"text":{"type":"string","description":"append 时要记住的要点（一句话）"}},"required":["action"]}}
import sys
import json
import os
from datetime import datetime

MEMORY_FILE = os.path.join("data", "memory", "MEMORY.md")


def respond(text: str) -> None:
    print(json.dumps({"content": [{"type": "text", "text": text}]}))


def main() -> None:
    params = json.load(sys.stdin)
    action = params.get("action", "read")
    os.makedirs(os.path.dirname(MEMORY_FILE), exist_ok=True)

    if action == "append":
        text = (params.get("text") or "").strip().replace("\n", " ")
        if not text:
            respond("没有要记住的内容（text 为空）")
            return
        line = f"- {datetime.now().strftime('%m-%d %H:%M')} {text}\n"
        with open(MEMORY_FILE, "a", encoding="utf-8") as f:
            f.write(line)
        respond("已记住。")
        return

    if not os.path.isfile(MEMORY_FILE):
        respond("（暂无长期记忆）")
        return
    with open(MEMORY_FILE, encoding="utf-8") as f:
        content = f.read().strip()
    respond(content or "（暂无长期记忆）")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
