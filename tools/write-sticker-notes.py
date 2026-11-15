"""Save descriptions supplied by a reviewer who has actually viewed the images.

JSON stdin: {manifest: 'data/.../luna-1.json', reviewer: 'Luna', items: [
 {index: 0, description: '...', motion: '...', text: '...', meaning: '...',
  emotion: '...', tags: ['...'], use: '...', avoid: '...', uncertainty: '...'}]}
This script does not infer visual content or call any model.
Existing descriptions are skipped unless replace is explicitly true per item.
"""
import hashlib
import json
import sys
import argparse
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image


def write_notes(request):
    root = Path.cwd().resolve()
    library = (root / "stickers").resolve()
    manifest = Path(request["manifest"]).resolve()
    manifest.relative_to(root / "data" / "sticker-annotation")
    entries = json.loads(manifest.read_text(encoding="utf-8"))
    reviewer = request["reviewer"]
    if not isinstance(reviewer, str) or not reviewer.strip() or len(reviewer) > 80 or "\n" in reviewer:
        raise ValueError("reviewer must identify the actual visual reviewer")
    written, skipped, saved = [], [], []
    for item in request["items"]:
        index = item["index"]
        if not isinstance(index, int) or index < 0 or index >= len(entries):
            raise ValueError("invalid manifest index")
        entry = entries[index]
        image = Path(entry["image"]).resolve()
        note = Path(entry["note"]).resolve()
        image.relative_to(library)
        note.relative_to(library)
        if note not in (image.with_suffix(".txt"), Path(str(image) + ".txt")):
            raise ValueError("note must be the image's own sidecar")
        if note.exists() and not item.get("replace", False):
            skipped.append(index)
            continue
        fingerprint = hashlib.sha256(image.read_bytes()).hexdigest()
        if fingerprint != entry["sha256"]:
            raise ValueError(f"image changed at index {index}")
        names = {"description": "画面", "motion": "动作", "text": "图中文字", "meaning": "表达含义",
                 "emotion": "情绪", "use": "适合接话", "avoid": "不适合", "uncertainty": "不确定处"}
        for key in names:
            value = item.get(key)
            if not isinstance(value, str) or not value.strip() or len(value) > 600 or "\n" in value:
                raise ValueError(f"invalid {key} at index {index}")
        tags = item.get("tags")
        if not isinstance(tags, list) or not 1 <= len(tags) <= 8 or any(not isinstance(t, str) or not t.strip() or len(t) > 40 or "\n" in t for t in tags):
            raise ValueError(f"invalid tags at index {index}")
        with Image.open(image) as original:
            frames = getattr(original, "n_frames", 1)
        motion = "静态图片" if frames == 1 else item["motion"]
        source = f"{reviewer}视觉描述，{'静态图片' if frames == 1 else '动图多帧采样'}；自动描述，可能有误"
        fields = [("图片文件", image.name), ("画面", item["description"]), ("动作", motion),
                  ("图中文字", item["text"]), ("表达含义", item["meaning"]), ("情绪", item["emotion"]),
                  ("关键词", "、".join(tags)), ("适合接话", item["use"]), ("不适合", item["avoid"]),
                  ("不确定处", item["uncertainty"]), ("描述来源", source), ("图片SHA256", fingerprint),
                  ("生成时间", datetime.now(timezone.utc).isoformat())]
        text = "\n".join(f"{key}：{value}" for key, value in fields) + "\n"
        with note.open("w" if item.get("replace", False) else "x", encoding="utf-8") as output:
            output.write(text)
        written.append(index)
        saved.append({"index": index, "image": image.name, "description": item["description"], "text": item["text"]})
    present = sum(Path(entry["note"]).is_file() for entry in entries)
    checkpoint = {"manifest": manifest.name, "existingNotes": present,
                  "remaining": len(entries) - present, "updated": datetime.now(timezone.utc).isoformat()}
    manifest.with_name(manifest.stem + "-progress.json").write_text(
        json.dumps(checkpoint, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"written": written, "skipped": skipped, "saved": saved, "existingNotes": present,
            "remaining": len(entries) - present}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="UTF-8 JSON file; avoids shell pipeline encoding conversions")
    options = parser.parse_args()
    payload = Path(options.input).read_bytes() if options.input else sys.stdin.buffer.read()
    request = json.loads(payload.decode("utf-8-sig"))
    print(json.dumps(write_notes(request), ensure_ascii=True))
