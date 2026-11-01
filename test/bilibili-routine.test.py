import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("bilibili_routine", Path(__file__).parent.parent / "tools/bilibili-mcp/mcp_server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class RoutineTest(unittest.IsolatedAsyncioTestCase):
    async def test_explore_deduplicates_seen_and_keeps_partial_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            server.ACTIVITY_FILE = Path(directory) / "history.jsonl"
            server.ACTIVITY_FILE.write_text(json.dumps({"type": "video_read", "bvid": "BV1234567890"}) + "\n", encoding="utf-8")
            found = {"videos": [{"bvid": "BV1234567890", "title": "seen"}, {"bvid": "BVabcdefghij", "title": "new"}]}
            with patch.object(server, "bili_search", new=AsyncMock(return_value=json.dumps(found))), patch.object(server, "bili_watch", new=AsyncMock(return_value=json.dumps({"info": {"error": "未登录"}, "recorded": False}))) as watch:
                result = json.loads(await server.bili_explore(["鲸鱼"], 2))
            self.assertEqual([video["bvid"] for video in result["videos"]], ["BVabcdefghij"])
            self.assertEqual(result["videos"][0]["read"]["info"]["error"], "未登录")
            watch.assert_awaited_once_with("BVabcdefghij", 8)

    async def test_reply_notifications_link_identity_and_detect_successful_prior_reply(self):
        with tempfile.TemporaryDirectory() as directory:
            server.ACTIVITY_FILE = Path(directory) / "history.jsonl"
            server.ACTIVITY_FILE.write_text(json.dumps({"bvid": "BV1234567890", "parent_rpid": "22"}) + "\n", encoding="utf-8")
            feed = {"items": [{"id": 9, "reply_time": 100, "user": {"mid": 123, "nickname": "鱼友"}, "item": {"business_id": 1, "uri": "https://www.bilibili.com/video/BV1234567890", "source_id": 22, "root_id": 11, "source_content": "你好", "target_reply_content": "我之前的评论"}}]}
            with patch.object(server, "get_cred", return_value=object()), patch.object(server.session, "get_replies", new=AsyncMock(return_value=feed)):
                result = json.loads(await server.bili_check_replies())
            reply = result["replies"][0]
            self.assertTrue(reply["already_replied"])
            self.assertTrue(reply["actionable"])
            self.assertEqual(reply["uid"], "123")
            self.assertEqual(reply["root_rpid"], "11")
            self.assertEqual(server._comment_authors[("BV1234567890", 22)]["content"], "你好")

    async def test_missing_login_does_not_claim_success(self):
        with patch.object(server, "get_cred", side_effect=Exception("未登录")):
            self.assertEqual(json.loads(await server.bili_check_replies())["error"], "未登录")

    async def test_reply_with_aid_but_no_bv_url_is_resolved(self):
        feed = {"items": [{"id": 10, "user": {"mid": 321, "nickname": "鱼友"}, "item": {"business_id": 1, "subject_id": 999, "source_id": 33, "root_id": 30, "source_content": "你好", "uri": "https://www.bilibili.com/video/av999"}}]}
        with tempfile.TemporaryDirectory() as directory:
            server.ACTIVITY_FILE = Path(directory) / "history.jsonl"
            api = SimpleNamespace(get_info=AsyncMock(return_value={"bvid": "BV1234567890"}))
            with patch.object(server, "get_cred", return_value=object()), patch.object(server.session, "get_replies", new=AsyncMock(return_value=feed)), patch.object(server.video, "Video", return_value=api):
                result = json.loads(await server.bili_check_replies())
            self.assertEqual(result["replies"][0]["bvid"], "BV1234567890")
            self.assertTrue(result["replies"][0]["actionable"])


if __name__ == "__main__":
    unittest.main()
