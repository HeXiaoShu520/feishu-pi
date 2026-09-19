#! {"name":"memory","description":"长期记忆（团队共享，全局唯一一份）：action=read 查看全部（条目过多时会提示整理）；action=append 追加一条要点；action=rewrite 用整理后的内容整体覆盖（去重/合并/清理过时条目）。何时使用：用户交代需要长期记住的事实、偏好或约定时，或对话中沉淀出值得保留的结论时，用 append 记下；当任务可能与既往背景相关时，先 read 回忆，避免重复询问。维护：条目重复、过时，或 read 时提示超限时，用 rewrite 用去重合并后的精简版整体覆盖（拒绝空内容）。禁止写入密码、令牌等敏感信息——记忆对团队全员可见。","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["read","append","rewrite"],"description":"read=查看全部，append=追加一条，rewrite=用整理后的内容整体覆盖"},"text":{"type":"string","description":"append=一条要点；rewrite=整理后的全部记忆（每行一条，保留时间前缀可省略）"}},"required":["action"]}}
# 说明：「何时该用 / 如何维护」这类策略写在上面的 description 里，而不是写进 .agent/SYSTEM.md。
# 工具描述随工具注册进入每次请求的模型上下文（注册了才出现，没注册就消失），
# 而 SYSTEM.md 是静态的——把工具用法写在那里，会出现「提示教模型用一个并不存在的工具」。
import sys
import json
import os
from datetime import datetime


def resolve_memory_file() -> str:
    """记忆文件位置：默认跟随进程 cwd，可用环境变量 FEISHU_PI_PROJECT_ROOT 覆盖。

    跟随 cwd 是为了与 runtime 其余部分保持一致——pi 的 agentDir、SYSTEM.md、skills
    全部基于 process.cwd()，启动目录不对的话那些也会一起失效，不是本工具特有的脆弱点。
    代价是：cwd 变了会指向另一个文件。所以「文件不存在」和「首次新建」都会把完整路径
    回给模型（见 main），让路径漂移当场可见，而不是静默写到别处或凭空变成空记忆。
    """
    root = os.environ.get("FEISHU_PI_PROJECT_ROOT") or os.getcwd()
    return os.path.join(os.path.abspath(root), "data", "memory", "MEMORY.md")


MEMORY_FILE = resolve_memory_file()
SOFT_LIMIT_LINES = 200
SOFT_LIMIT_BYTES = 64 * 1024


def respond(text: str) -> None:
    print(json.dumps({"content": [{"type": "text", "text": text}]}))


def read_all() -> str:
    if not os.path.isfile(MEMORY_FILE):
        return ""
    with open(MEMORY_FILE, encoding="utf-8") as f:
        return f.read()


def write_line(line: str) -> bool:
    """追加一行；返回是否为此新建了文件。"""
    created = not os.path.isfile(MEMORY_FILE)
    os.makedirs(os.path.dirname(MEMORY_FILE), exist_ok=True)
    with open(MEMORY_FILE, "a", encoding="utf-8") as f:
        f.write(line)
    return created


def main() -> None:
    params = json.load(sys.stdin)
    action = params.get("action", "read")

    if action == "append":
        text = (params.get("text") or "").strip().replace("\n", " ")
        if not text:
            respond("没有要记住的内容（text 为空）")
            return
        line = f"- {datetime.now().strftime('%m-%d %H:%M')} {text}\n"
        created = write_line(line)
        # 新建文件时把路径回给模型：cwd 漂移导致「记忆换了个地方」的情况当场可见
        respond(f"已记住。（新建于 {MEMORY_FILE}）" if created else "已记住。")
        return

    if action == "rewrite":
        text = (params.get("text") or "").strip()
        if not text:
            respond("❌ rewrite 需要整理后的完整内容（text），拒绝清空记忆")
            return
        os.makedirs(os.path.dirname(MEMORY_FILE), exist_ok=True)
        with open(MEMORY_FILE, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        respond("已用整理后的内容覆盖记忆。")
        return

    # read：返回全部记忆；超限时提示整理
    if not os.path.isfile(MEMORY_FILE):
        # 不替调用方创建空文件（read 应是只读动作），并把路径摊开
        respond(f"（记忆文件尚不存在：{MEMORY_FILE}）\n若这不是预期位置，说明进程启动目录不对——可设 FEISHU_PI_PROJECT_ROOT 指定工程根目录。")
        return
    content = read_all()
    if not content.strip():
        respond(f"（暂无长期记忆，文件：{MEMORY_FILE}）")
        return
    size = os.path.getsize(MEMORY_FILE)
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
