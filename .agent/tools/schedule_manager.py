#! {"name":"schedule_manager","description":"管理定时任务：查看列表、创建、删除、启用/停用、立即执行；任务持久化在 data/schedules.json","parameters":{"type":"object","properties":{"action":{"type":"string","description":"操作类型：list/add/remove/toggle/run","enum":["list","add","remove","toggle","run"]},"cron":{"type":"string","description":"创建时：cron 表达式（5段，如 0 9 * * *）"},"prompt":{"type":"string","description":"创建时：任务执行时的完整指令。必须自包含——执行时 AI 只能看到这句话，看不到创建时的对话。需写明：具体做什么、对象/范围、输出格式与篇幅。应把当前对话中与任务相关的上下文（城市、对象、偏好等）固化进去"},"name":{"type":"string","description":"创建时：任务名（可选，默认取 prompt 前20字）"},"chatId":{"type":"string","description":"创建时：执行会话 ID"},"createdBy":{"type":"string","description":"创建时：创建者 Open ID"},"id":{"type":"string","description":"删除/切换/执行时：任务 ID"},"enabled":{"type":"boolean","description":"切换时：是否启用"}},"required":["action"]}}
import sys
import json
import os
from datetime import datetime

SCHEDULES_FILE = os.path.join("data", "schedules.json")


def load_tasks():
    """加载定时任务列表"""
    if not os.path.isfile(SCHEDULES_FILE):
        return []
    try:
        with open(SCHEDULES_FILE, "r", encoding="utf-8") as f:
            content = f.read().strip()
            if not content:
                return []
            tasks = json.loads(content)
            return tasks if isinstance(tasks, list) else []
    except (json.JSONDecodeError, IOError):
        return []


def save_tasks(tasks):
    """保存定时任务列表"""
    os.makedirs(os.path.dirname(SCHEDULES_FILE), exist_ok=True)
    with open(SCHEDULES_FILE, "w", encoding="utf-8") as f:
        json.dump(tasks, f, ensure_ascii=False, indent=2)


def generate_id():
    """生成唯一 ID"""
    import random
    ts = int(datetime.now().timestamp() * 1000)
    rand = random.randint(1000, 9999)
    return f"{ts}_{rand}"


def format_task(task):
    """格式化单个任务信息"""
    status = "✅ 启用" if task.get("enabled", False) else "⏹️ 停用"
    last_run = task.get("lastRunAt", 0)
    last_status = task.get("lastStatus", "")
    last_error = task.get("lastError", "")

    info = f"  ID: {task.get('id', '')}\n"
    info += f"  名称: {task.get('name', '(未命名)')}\n"
    info += f"  状态: {status}\n"
    info += f"  调度: {task.get('cron', '')}\n"
    info += f"  指令: {task.get('prompt', '')}"
    if last_run:
        try:
            dt = datetime.fromtimestamp(last_run / 1000)
            info += f"\n  上次执行: {dt.strftime('%Y-%m-%d %H:%M')}"
        except (OSError, ValueError):
            pass
    if last_status:
        info += f"\n  上次状态: {last_status}"
    if last_error:
        info += f"\n  上次错误: {last_error}"
    return info


def action_list(params):
    """查看任务列表"""
    tasks = load_tasks()
    if not tasks:
        return {"content": [{"type": "text", "text": "当前没有定时任务"}]}

    lines = [f"📋 定时任务列表（共 {len(tasks)} 个）：", ""]
    for task in tasks:
        lines.append(format_task(task))
        lines.append("---")

    lines.append("💡 提示：新增/修改/删除任务后，重启服务才能应用新的调度计划")

    return {"content": [{"type": "text", "text": "\n".join(lines)}]}


def action_add(params):
    """创建新任务"""
    cron = params.get("cron", "").strip()
    if not cron:
        return {"content": [{"type": "text", "text": "❌ 缺少 cron 表达式"}]}

    prompt = params.get("prompt", "").strip()
    if not prompt:
        return {"content": [{"type": "text", "text": "❌ 缺少任务指令 (prompt)"}]}

    # 自包含性校验：执行时 AI 只能看到这句话，过短意味着上下文会丢失
    if len(prompt) < 15:
        return {"content": [{"type": "text", "text":
            "❌ 任务指令过于简略（当前仅 %d 字）。执行时 AI 只能看到这句话，看不到创建时的对话，"
            "请写明：具体做什么、对象/范围、输出格式与篇幅。"
            "示例：查询北京今天的天气，用不超过三句话总结温度、降水和穿衣建议" % len(prompt)}]}

    name = params.get("name", "").strip() or prompt[:20]
    chat_id = params.get("chatId", "").strip()
    created_by = params.get("createdBy", "").strip()

    new_task = {
        "id": generate_id(),
        "name": name,
        "cron": cron,
        "prompt": prompt,
        "chatId": chat_id,
        "createdBy": created_by,
        "enabled": True,
        "createdAt": datetime.now().isoformat(),
        "lastRunAt": 0,
        "lastStatus": "",
        "lastError": None,
    }

    tasks = load_tasks()
    tasks.append(new_task)
    save_tasks(tasks)

    lines = [
        f"✅ 任务创建成功",
        format_task(new_task),
        "",
        "⚠️ 新任务将在服务重启后自动恢复调度。如需立即生效，请重启服务。",
    ]
    return {"content": [{"type": "text", "text": "\n".join(lines)}]}


def action_remove(params):
    """删除任务"""
    task_id = params.get("id", "").strip()
    if not task_id:
        return {"content": [{"type": "text", "text": "❌ 缺少任务 ID"}]}

    tasks = load_tasks()
    before = len(tasks)
    tasks = [t for t in tasks if t.get("id") != task_id]

    if len(tasks) == before:
        return {"content": [{"type": "text", "text": f"❌ 未找到 ID 为 {task_id} 的任务"}]}

    save_tasks(tasks)
    return {"content": [{"type": "text", "text": f"✅ 已删除任务 {task_id}"}]}


def action_toggle(params):
    """启用/停用任务"""
    task_id = params.get("id", "").strip()
    if not task_id:
        return {"content": [{"type": "text", "text": "❌ 缺少任务 ID"}]}

    enabled = params.get("enabled")
    if enabled is None:
        return {"content": [{"type": "text", "text": "❌ 缺少 enabled 参数"}]}

    tasks = load_tasks()
    found = False
    for task in tasks:
        if task.get("id") == task_id:
            task["enabled"] = enabled
            found = True
            break

    if not found:
        return {"content": [{"type": "text", "text": f"❌ 未找到 ID 为 {task_id} 的任务"}]}

    save_tasks(tasks)
    status = "启用" if enabled else "停用"
    return {"content": [{"type": "text", "text": f"✅ 已{status}任务 {task_id}"}]}


def action_run(params):
    """立即执行一次（返回任务指令，由 AI 在当前会话执行）"""
    task_id = params.get("id", "").strip()
    if not task_id:
        return {"content": [{"type": "text", "text": "❌ 缺少任务 ID"}]}

    tasks = load_tasks()
    for task in tasks:
        if task.get("id") == task_id:
            prompt = task.get("prompt", "")
            # 更新 lastRunAt
            task["lastRunAt"] = int(datetime.now().timestamp() * 1000)
            save_tasks(tasks)
            return {"content": [{"type": "text", "text": f"🔧 正在执行任务「{task.get('name', '')}」：\n{prompt}"}]}

    return {"content": [{"type": "text", "text": f"❌ 未找到 ID 为 {task_id} 的任务"}]}


ACTIONS = {
    "list": action_list,
    "add": action_add,
    "remove": action_remove,
    "toggle": action_toggle,
    "run": action_run,
}


def main():
    params = json.load(sys.stdin)
    action = params.get("action", "").strip().lower()

    handler = ACTIONS.get(action)
    if not handler:
        valid = ", ".join(ACTIONS.keys())
        result = {"content": [{"type": "text", "text": f"❌ 不支持的 action: {action}，可选: {valid}"}]}
        print(json.dumps(result))
        return

    result = handler(params)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)