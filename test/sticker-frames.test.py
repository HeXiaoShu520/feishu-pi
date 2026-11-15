"""Preview decoding checks: python test/sticker-frames.test.py."""
import base64
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageChops, ImageDraw, ImageFile

spec = importlib.util.spec_from_file_location("sticker_frames", Path(__file__).resolve().parents[1] / "tools" / "sticker-frames.py")
frames = importlib.util.module_from_spec(spec)
spec.loader.exec_module(frames)


class PreviewTests(unittest.TestCase):
    def test_recovery_warning_is_not_lost_for_later_images_in_a_batch(self):
        previous = ImageFile.LOAD_TRUNCATED_IMAGES
        def incomplete_image(_path, _frames):
            if not ImageFile.LOAD_TRUNCATED_IMAGES:
                raise OSError("incomplete image stream")
            return {"data": "recovered"}
        with patch.object(frames, "decode_preview", side_effect=incomplete_image):
            self.assertIn("warning", frames.preview("first.gif"))
            self.assertEqual(ImageFile.LOAD_TRUNCATED_IMAGES, previous)
            self.assertIn("warning", frames.preview("second.gif"))
            self.assertEqual(ImageFile.LOAD_TRUNCATED_IMAGES, previous)

    def test_shared_crop_preserves_motion_between_samples(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "moving.gif"
            first = Image.new("RGB", (80, 40), "white")
            second = first.copy()
            ImageDraw.Draw(first).rectangle((10, 12, 20, 22), fill="blue")
            ImageDraw.Draw(second).rectangle((60, 12, 70, 22), fill="blue")
            first.save(path, save_all=True, append_images=[second], duration=[100, 100], loop=0)
            result = frames.preview(path)
            self.assertEqual(result["sampledFrames"], [1, 2])
            sheet = Image.open(io.BytesIO(base64.b64decode(result["data"]))).convert("RGB")
            def object_box(tile):
                return ImageChops.difference(tile, Image.new("RGB", tile.size, "white")).getbbox()
            left = object_box(sheet.crop((0, 0, 384, 320)))
            right = object_box(sheet.crop((384, 0, 768, 320)))
            self.assertIsNotNone(left)
            self.assertIsNotNone(right)
            self.assertLess(left[2], right[0])

    def test_transparency_composites_to_white_without_inventing_content(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "empty.png"
            Image.new("RGBA", (80, 40), (0, 0, 0, 0)).save(path)
            result = frames.preview(path)
            self.assertEqual(result["frameCount"], 1)
            sheet = Image.open(io.BytesIO(base64.b64decode(result["data"]))).convert("RGB")
            self.assertIsNone(ImageChops.difference(sheet, Image.new("RGB", sheet.size, "white")).getbbox())

    def test_white_art_on_transparency_remains_visible(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "white-art.png"
            original = Image.new("RGBA", (80, 40), (0, 0, 0, 0))
            ImageDraw.Draw(original).rectangle((25, 10, 50, 30), fill=(255, 255, 255, 255))
            original.save(path)
            result = frames.preview(path)
            self.assertEqual(result["background"], "gray_for_transparency")
            sheet = Image.open(io.BytesIO(base64.b64decode(result["data"]))).convert("RGB")
            self.assertIsNotNone(ImageChops.difference(sheet, Image.new("RGB", sheet.size, "white")).getbbox())
            self.assertEqual(sheet.getpixel((384, 384)), (255, 255, 255))

    def test_exif_rotation_keeps_full_visible_content(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "rotated.jpg"
            image = Image.new("RGB", (90, 40), "white")
            draw = ImageDraw.Draw(image)
            draw.rectangle((5, 5, 20, 20), fill="red")
            draw.rectangle((65, 5, 80, 20), fill="blue")
            exif = Image.Exif()
            exif[274] = 6
            image.save(path, exif=exif, quality=100)
            result = frames.preview(path)
            sheet = Image.open(io.BytesIO(base64.b64decode(result["data"]))).convert("RGB")
            pixels = list(sheet.getdata())
            self.assertTrue(any(r > 160 and g < 80 and b < 80 for r, g, b in pixels))
            self.assertTrue(any(b > 160 and r < 80 and g < 80 for r, g, b in pixels))


if __name__ == "__main__":
    unittest.main()
