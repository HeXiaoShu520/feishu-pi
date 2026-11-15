"""Read one local image; return a bounded PNG preview and its source fingerprint.

JSON stdin: {"path": "..."}. JSON stdout is consumed by the annotation/preview tools.
Animated images are sampled across their timeline, never described from frame zero alone.
Requires Pillow (python -m pip install Pillow).
"""
import base64
import hashlib
import io
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps, ImageFile, ImageChops


def decode_preview(path, frames=6):
    data = Path(path).read_bytes()
    if not data or len(data) > 20 * 1024 * 1024:
        raise ValueError("image must be between 1 byte and 20 MiB")
    with Image.open(io.BytesIO(data)) as image:
        count = getattr(image, "n_frames", 1)
        if count > 2500:
            raise ValueError("animation exceeds 2500 frames")
        durations = []
        for index in range(count):
            image.seek(index)
            durations.append(max(10, int(image.info.get("duration", 100))))
        total = sum(durations)
        frame_count = max(1, min(12, int(frames)))
        targets = [total * i / max(1, frame_count - 1) for i in range(frame_count)] if count > 1 else [0]
        indices = []
        elapsed = 0
        for index, duration in enumerate(durations):
            while targets and (targets[0] < elapsed + duration or index == count - 1):
                targets.pop(0)
                if not indices or indices[-1][0] != index:
                    indices.append((index, elapsed))
            elapsed += duration
        animated = len(indices) > 1
        width, height = (384, 320) if animated else (768, 768)
        sampled = []
        originals = []
        for index, _ in indices:
            image.seek(index)
            originals.append(ImageOps.exif_transpose(image.convert("RGBA")))
        transparent = any(frame.getextrema()[3][0] < 255 and frame.getchannel("A").getbbox() for frame in originals)
        background = "#bcbcbc" if transparent else "white"
        bounds = None
        for frame in originals:
            surface = Image.new("RGBA", frame.size, background)
            surface.alpha_composite(frame)
            frame = surface.convert("RGB")
            sampled.append(frame)
            box = ImageChops.difference(frame, Image.new("RGB", frame.size, background)).convert("L").point(lambda value: 255 if value > 8 else 0).getbbox()
            if box:
                bounds = box if bounds is None else (min(bounds[0], box[0]), min(bounds[1], box[1]), max(bounds[2], box[2]), max(bounds[3], box[3]))
        if bounds:
            # Remove only empty background border. Use one union box for every sample
            # so translations between frames remain visible instead of being recentered away.
            bounds = (max(0, bounds[0] - 4), max(0, bounds[1] - 4), min(sampled[0].width, bounds[2] + 4), min(sampled[0].height, bounds[3] + 4))
        tiles = []
        for (index, at), frame in zip(indices, sampled):
            if bounds:
                frame = frame.crop(bounds)
            # Tiny chat stickers need enlargement too; thumbnail() only shrinks and
            # would leave a 32px character unreadable in a large white tile.
            scale = min(width / frame.width, height / frame.height, 8)
            frame = frame.resize((max(1, round(frame.width * scale)), max(1, round(frame.height * scale))), Image.Resampling.LANCZOS)
            tile = Image.new("RGB", (width, height + (24 if animated else 0)), "white")
            tile.paste(frame, ((width - frame.width) // 2, (height - frame.height) // 2))
            if animated:
                ImageDraw.Draw(tile).text((8, height + 4), f"frame {index + 1}/{count}  {at / 1000:.2f}s", fill="black")
            tiles.append(tile)
        if animated:
            sheet = Image.new("RGB", (width * 3, (height + 24) * ((len(tiles) + 2) // 3)), "#dddddd")
            for index, tile in enumerate(tiles):
                sheet.paste(tile, ((index % 3) * width, (index // 3) * (height + 24)))
        else:
            sheet = tiles[0]
        output = io.BytesIO()
        sheet.save(output, format="PNG", optimize=True)
        return {"data": base64.b64encode(output.getvalue()).decode("ascii"), "mimeType": "image/png",
                "sha256": hashlib.sha256(data).hexdigest(), "frameCount": count,
                "sampledFrames": [i + 1 for i, _ in indices], "durationMs": total if count > 1 else 0,
                "background": "gray_for_transparency" if transparent else "white"}


def preview(path, frames=6):
    previous = ImageFile.LOAD_TRUNCATED_IMAGES
    try:
        ImageFile.LOAD_TRUNCATED_IMAGES = False
        try:
            return decode_preview(path, frames)
        except OSError:
            ImageFile.LOAD_TRUNCATED_IMAGES = True
            result = decode_preview(path, frames)
            result["warning"] = "原图数据流不完整，预览来自可恢复画面，可能缺少部分内容"
            return result
    finally:
        ImageFile.LOAD_TRUNCATED_IMAGES = previous


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        print(json.dumps(preview(request["path"], request.get("frames", 6)), ensure_ascii=True))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True))
        sys.exit(1)
