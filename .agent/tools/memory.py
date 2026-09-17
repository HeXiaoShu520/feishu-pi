#! {"name":"memory","description":"长期记忆（全局唯一一份：data/memory/MEMORY.md，所有会话与用户共用）：action=read 查看（记忆过多时会提示整理）；action=append 追加一条要点；action=rewrite 用整理后的内容整体覆盖（去重/合并/清理过时条目）。","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["read","append","rewrite"],"description":"read=查看全部，append=追加一条，rewrite=用整理后的内容整体覆盖"},"text":{"type":"string","description":"append=一条要点；rewrite=整理后的全部记忆（每行一条，保留时间前缀可省略）"}},"required":["action"]}}
import sys
import json
import os
from datetime import datetime

MEMORY_FILE = os.path.join("data", "memory", "MEMORY.md")
SOFT_LIMIT_LINES = 200
SOFT_LIMIT_BYTES = 64 * 1024


def respond(text: str) -> None:
    print(json.dumps({"content": [{"type": "text", "text": text}]}))


def read_all() -> str:
    if not os.path.isfile(MEMORY_FILE):
        return ""
    with open(MEMORY_FILE, encoding="utf-8") as f:
        return f.read()


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

    if action == "rewrite":
        text = (params.get("text") or "").strip()
        if not text:
            respond("❌ rewrite 需要整理后的完整内容（text），拒绝清空记忆")
            return
        with open(MEMORY_FILE, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        respond("已用整理后的内容覆盖记忆。")
        return

    # read：返回全部记忆；超限时提示整理
    content = read_all()
    if not content:
        respond("（暂无长期记忆）")
        return
    size = os.path.getsize(MEMORY_FILE) if os.path.isfile(MEMORY_FILE) else 0
    lines = content.count("\n")
    if size > SOFT_LIMIT_BYTES or lines > SOFT_LIMIT_LINES:
        content += f"\n\n⚠️ 记忆已达 {lines} 行 / {size // 1024} KB：请先 read 通读，再去重合并过时条目后，调用 rewrite 用精简版整体覆盖。"
    respond(content)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
