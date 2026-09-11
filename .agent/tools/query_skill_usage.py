#! {"name":"query_skill_usage","description":"查询技能使用统计，读取 data/stats/skill-usage.jsonl 并按技能汇总排行，支持近 7 天筛选和个人统计","parameters":{"type":"object","properties":{}}}
import sys
import json
import os
from glob import glob
from datetime import datetime

STATS_DIR = os.path.join("data", "stats")
SKILL_USAGE_FILE = os.path.join(STATS_DIR, "skill-usage.jsonl")
USERS_DIR = os.path.join("data", "users")


def load_usage_events():
    """加载技能使用事件流"""
    if not os.path.isfile(SKILL_USAGE_FILE):
        return []
    events = []
    with open(SKILL_USAGE_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return events


def load_user_map():
    """加载用户资料映射：open_id -> display_name"""
    user_map = {}
    if not os.path.isdir(USERS_DIR):
        return user_map
    for fpath in glob(os.path.join(USERS_DIR, "*_users.json")):
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                users = json.load(f)
                if isinstance(users, list):
                    for u in users:
                        uid = u.get("open_id") or u.get("user_id") or u.get("id")
                        if uid:
                            name = u.get("englishName") or u.get("name") or uid
                            user_map[uid] = name
                elif isinstance(users, dict):
                    for uid, info in users.items():
                        name = info.get("englishName") if isinstance(info, dict) else uid
                        user_map[uid] = name or uid
        except (json.JSONDecodeError, IOError):
            continue
    return user_map


def format_ts(ts_ms):
    """格式化时间戳为 月-日 时:分"""
    try:
        dt = datetime.fromtimestamp(ts_ms / 1000)
        return dt.strftime("%m-%d %H:%M")
    except (OSError, ValueError):
        return str(ts_ms)


def aggregate(events, user_map):
    """按技能聚合统计"""
    now_ms = datetime.now().timestamp() * 1000
    seven_days_ago = now_ms - 7 * 24 * 60 * 60 * 1000

    skills = {}  # skill_name -> {count, users:set, last_ts, last_user}
    total_count = 0
    total_users = set()
    recent_count = 0
    recent_users = set()

    for ev in events:
        skill = ev.get("skill", "unknown")
        user = ev.get("user", "unknown")
        ts = ev.get("ts", 0)

        total_count += 1
        total_users.add(user)

        if ts >= seven_days_ago:
            recent_count += 1
            recent_users.add(user)

        if skill not in skills:
            skills[skill] = {"count": 0, "users": set(), "last_ts": 0, "last_user": ""}

        s = skills[skill]
        s["count"] += 1
        s["users"].add(user)
        if ts > s["last_ts"]:
            s["last_ts"] = ts
            s["last_user"] = user

    # 排序
    sorted_skills = sorted(skills.items(), key=lambda x: x[1]["count"], reverse=True)
    top_skills = sorted_skills[:10]

    lines = []
    lines.append(f"📊 技能使用统计：累计 {total_count} 次，涉及 {len(skills)} 个技能、{len(total_users)} 位用户；近 7 天 {recent_count} 次")
    lines.append("")
    lines.append("技能排行：")
    for i, (name, info) in enumerate(top_skills, 1):
        last_user_display = user_map.get(info["last_user"], info["last_user"])
        lines.append(f"{i}. {name} — {info['count']} 次 · {len(info['users'])} 人使用 · 最近 {format_ts(info['last_ts'])} {last_user_display}")

    return "\n".join(lines)


def main():
    params = json.load(sys.stdin)
    caller_open_id = params.get("callerOpenId", "")

    events = load_usage_events()
    if not events:
        result_text = "目前还没有任何技能使用记录"
        print(json.dumps({"content": [{"type": "text", "text": result_text}]}))
        return

    user_map = load_user_map()
    result_text = aggregate(events, user_map)

    # 如果提供了调用者 Open ID，追加个人统计
    if caller_open_id:
        personal = [ev for ev in events if ev.get("user") == caller_open_id]
        if personal:
            personal_skills = {}
            for ev in personal:
                skill = ev.get("skill", "unknown")
                personal_skills[skill] = personal_skills.get(skill, 0) + 1
            sorted_personal = sorted(personal_skills.items(), key=lambda x: x[1], reverse=True)
            personal_lines = [f"你的使用（共 {len(personal)} 次）：" +
                              "、".join(f"{s} × {c}" for s, c in sorted_personal)]
            result_text += "\n\n" + "\n".join(personal_lines)

    print(json.dumps({"content": [{"type": "text", "text": result_text}]}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)