"""Produce a readable contact sheet for visual review, never infer descriptions.

python tools/sticker-contact-sheet.py --manifest data/sticker-annotation/luna-1.json \
  --queue data/sticker-annotation/luna-priority-1.json --count 6 \
  --output data/sticker-annotation/luna1-current.png
Only a small JSON list is printed. Open the PNG with view_image; do not reconstruct
an image from a truncated base64 string in terminal output.
"""
import argparse
import base64
import importlib.util
import io
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--queue")
    parser.add_argument("--count", type=int, default=6)
    parser.add_argument("--start", type=int, default=0, help="Offset in still-missing items")
    parser.add_argument("--include-existing", action="store_true", help="For verification only")
    parser.add_argument("--output", required=True)
    options = parser.parse_args()
    if not 1 <= options.count <= 12 or options.start < 0:
        raise ValueError("count must be 1..12; start must be nonnegative")
    root = Path.cwd().resolve()
    library = (root / "stickers").resolve()
    output = Path(options.output).resolve()
    output.relative_to(root / "data" / "sticker-annotation")
    entries = json.loads(Path(options.manifest).read_text(encoding="utf-8-sig"))
    queue = json.loads(Path(options.queue).read_text(encoding="utf-8-sig")) if options.queue else list(range(len(entries)))
    missing = [index for index in queue if options.include_existing or not Path(entries[index]["note"]).exists()]
    selected = missing[options.start:options.start + options.count]
    spec = importlib.util.spec_from_file_location("sticker_frames", Path(__file__).with_name("sticker-frames.py"))
    frames = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(frames)
    previews = []
    for index in selected:
        path = Path(entries[index]["image"]).resolve()
        path.relative_to(library)
        try:
            value = frames.preview(path)
            previews.append((index, value))
        except Exception as error:
            previews.append((index, {"error": str(error)}))
    # Give animations enough room to see each sampled frame. Unshown items stay missing.
    animated = any(value.get("frameCount", 1) > 1 for _, value in previews)
    if animated:
        previews = previews[:6]
    if not previews:
        print(json.dumps({"items": [], "remaining": len(missing)}))
        return
    columns, width, height = (2, 768, 480) if animated else (3, 512, 480)
    header = 32
    rows = (len(previews) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * width, rows * (height + header)), "#e8e8e8")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for font_name in ("consolab.ttf", "DejaVuSans-Bold.ttf"):
        try:
            font = ImageFont.truetype(font_name, 24)
            break
        except OSError:
            pass
    summary = []
    for position, (index, value) in enumerate(previews):
        x, y = position % columns * width, position // columns * (height + header)
        draw.rectangle((x, y, x + width - 1, y + header - 1), fill="#fff0b3")
        draw.text((x + 8, y + 2), f"INDEX {index}  frames={value.get('frameCount', '?')}", fill="black", font=font)
        if "error" in value:
            draw.text((x + 8, y + 50), "DECODE FAILED - do not describe unseen image", fill="red")
            summary.append({"index": index, "error": value["error"]})
            continue
        with Image.open(io.BytesIO(base64.b64decode(value["data"]))) as preview:
            tile = preview.convert("RGB")
            tile.thumbnail((width, height), Image.Resampling.LANCZOS)
            sheet.paste(tile, (x + (width - tile.width) // 2, y + header + (height - tile.height) // 2))
        summary.append({"index": index, "frames": value["frameCount"], "sampled": value["sampledFrames"], "warning": value.get("warning"), "background": value.get("background")})
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, format="PNG")
    print(json.dumps({"output": str(output), "items": summary, "remaining": len(missing)}, ensure_ascii=True))


if __name__ == "__main__":
    main()
