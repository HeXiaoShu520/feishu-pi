import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock

spec = importlib.util.spec_from_file_location("bilibili_server", Path(__file__).parent.parent / "tools/bilibili-mcp/mcp_server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class WatchTest(unittest.IsolatedAsyncioTestCase):
    async def test_person_history_uses_uid_not_name_and_survives_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            server.ACTIVITY_FILE = Path(directory) / "history.jsonl"
            events = [
                {"bvid": "BV1", "reply_to": {"uid": "12", "name": "小鱼", "content": "我喜欢猫"}, "text": "我也喜欢"},
                {"bvid": "BV2", "reply_to": {"uid": "34", "name": "小鱼", "content": "我喜欢狗"}, "text": "狗真好"},
                {"bvid": "BV3", "reply_to": {"uid": "12", "name": "新名字", "content": "你好"}, "text": "你好呀"},
                {"bvid": "BV4", "reply_to": None, "text": "不知道回复了谁"},
            ]
            server.ACTIVITY_FILE.write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in events) + "\n", encoding="utf-8")
            result = json.loads(await server.bili_person("12"))
            self.assertEqual(result["interaction_count"], 2)
            self.assertEqual(result["name"], "新名字")
            self.assertEqual([e["bvid"] for e in result["interactions"]], ["BV3", "BV1"])
            self.assertEqual(result["interactions"][1]["their_comment"], "我喜欢猫")
            self.assertIn("error", json.loads(await server.bili_person("../12")))

    async def test_person_facts_need_recorded_evidence_and_are_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            server.ACTIVITY_FILE = Path(directory) / "history.jsonl"
            event = {"bvid": "BV1", "parent_rpid": "42", "reply_to": {"uid": "12", "name": "鱼", "content": "我喜欢猫"}, "text": "猫很可爱"}
            server.ACTIVITY_FILE.write_text(json.dumps(event, ensure_ascii=False) + "\n", encoding="utf-8")
            self.assertFalse(json.loads(await server.bili_remember_person("34", "喜欢猫", "BV1", "42"))["success"])
            self.assertTrue(json.loads(await server.bili_remember_person("12", "喜欢猫", "BV1", "42"))["created"])
            self.assertFalse(json.loads(await server.bili_remember_person("12", "喜欢猫", "BV1", "42"))["created"])
            self.assertEqual(json.loads(await server.bili_person("12"))["facts"][0]["evidence"], "我喜欢猫")
            self.assertEqual(json.loads(await server.bili_person("34"))["facts"], [])

    async def test_partial_failure_records_only_actual_read(self):
        with tempfile.TemporaryDirectory() as directory:
            server.ACTIVITY_FILE = Path(directory) / "history.jsonl"
            server.bili_video_info = AsyncMock(return_value=json.dumps({"title": "视频", "author": "作者"}))
            server.bili_subtitle = AsyncMock(side_effect=Exception("无字幕权限"))
            server.bili_comments = AsyncMock(return_value=json.dumps({"count": 1, "comments": []}))
            result = json.loads(await server.bili_watch("BVtest", 100))
            self.assertEqual(result["subtitle"]["error"], "无字幕权限")
            self.assertTrue(result["recorded"])
            self.assertEqual(json.loads(server.ACTIVITY_FILE.read_text(encoding="utf-8"))["type"], "video_read")
            server.bili_comments.assert_awaited_once_with("BVtest", 20)

    async def test_failed_info_does_not_claim_video_was_read(self):
        with tempfile.TemporaryDirectory() as directory:
            server.ACTIVITY_FILE = Path(directory) / "history.jsonl"
            server.bili_video_info = AsyncMock(side_effect=Exception("未登录"))
            server.bili_subtitle = AsyncMock(return_value="{}")
            server.bili_comments = AsyncMock(return_value="{}")
            result = json.loads(await server.bili_watch("BVtest"))
            self.assertFalse(result["recorded"])
            self.assertFalse(server.ACTIVITY_FILE.exists())


if __name__ == "__main__":
    unittest.main()
