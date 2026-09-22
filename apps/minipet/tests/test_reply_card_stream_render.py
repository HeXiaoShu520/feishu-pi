# coding:utf-8
"""流式大块到达时卡片正文必须继续逐字输出，不得瞬间整段替换。"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from PySide6.QtWidgets import QApplication

from widgets.notifications.reply_card_center import ReplyCardCenter
from typewriter import Typewriter


class StreamRenderTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.center = ReplyCardCenter()
        self.set_text_calls = []
        self._orig_set_text = Typewriter.set_text
        Typewriter.set_text = lambda self_tw, t: self.set_text_calls.append(len(t or ''))

    def tearDown(self):
        Typewriter.set_text = self._orig_set_text

    def test_chunky_final_stream_continues_typing(self):
        """复现真实日志场景：建卡 7 字后，done 直接到达 259 字全文。"""
        full = ('（被这声“嘿嘿”逗得小脸蛋一红，脑袋上像冒出一朵小蘑菇）诶！这个“嘿嘿”听起来就不太对劲！'
                '大宝宝是不是又在偷偷笑我呀？🐶\\n\\n还是说，其实是你在那边研究 openDeepWiki 研究出什么坏主意了，'
                '想拉我一起干坏事呀？嘿嘿嘿～（小呆也学着你坏笑两声）\\n\\n好啦好啦，大宝宝想说什么都可以，'
                '小呆都在这里竖着耳朵听呢～嘿嘿归嘿嘿，记得随时告诉我你在想什么就好啦！😘')
        card_id = self.center.setup_reply_card(
            {'content': full[:7], 'elements': [], 'status': 'streaming', 'timeout_ms': 0},
            100, 100, play_sound=False)
        card = self.center.reply_cards[card_id]
        tw = card._primary_typewriter
        self.app.processEvents()

        self.center.update_reply_card(
            card_id, {'content': full, 'elements': [], 'status': 'done', 'timeout_ms': 0}, timeout=0)
        self.app.processEvents()

        # 必须继续逐字输出（shown < target），而不是 set_text 瞬间渲染
        self.assertEqual([], self.set_text_calls)
        self.assertLess(tw._shown, len(tw._target))
        self.assertTrue(tw._timer.isActive())

    def test_genuine_replacement_types_out(self):
        """内容大改（全新回复替换旧回复）同样逐字输出，不再瞬间整段渲染"""
        card_id = self.center.setup_reply_card(
            {'content': '旧内容' * 100, 'elements': [], 'status': 'done', 'timeout_ms': 0},
            100, 100, play_sound=False)
        card = self.center.reply_cards[card_id]
        self.app.processEvents()

        self.center.update_reply_card(
            card_id, {'content': '全新内容', 'elements': [], 'status': 'done', 'timeout_ms': 0}, timeout=0)
        self.app.processEvents()

        self.assertEqual([], self.set_text_calls)
        self.assertEqual('全新内容', card._primary_text)

    def test_formatted_streaming_height_monotonic(self):
        """带格式（hr/加粗/段落）的流式回复，卡片高度只增不减不抖动。"""
        full = ('哥哥坐好，我给你讲一个暖暖的小故事～ 🌙\n---\n'
                '**《月光修理铺》**\n\n在月亮背面，有一家小小的修理铺，老板是一只年迈的狐狸。'
                '一天夜里，来了个哭鼻子的女孩。她捧着一只掉了一颗纽扣的布熊。\n\n'
                '狐狸把布熊放到窗台上，月光洒下来，那半颗眼珠闪着莹莹的光。\n\n'
                '故事讲完啦，哥哥～你觉得怎么样？要是想听别的，我再换个风格的讲给你。😊')
        card_id = self.center.setup_reply_card(
            {'content': full[:15], 'elements': [], 'status': 'streaming', 'timeout_ms': 0},
            100, 100, play_sound=False)
        card = self.center.reply_cards[card_id]
        tw = card._primary_typewriter
        heights = []
        prev = -1
        grown = 15
        while grown < len(full):
            grown = min(grown + 24, len(full))
            self.center.update_reply_card(
                card_id, {'content': full[:grown], 'elements': [], 'status': 'streaming', 'timeout_ms': 0},
                timeout=0)
            for _ in range(500):
                if tw._shown >= len(tw._target):
                    break
                tw._tick()
                self.app.processEvents()
            card._do_streaming_resize()
            self.app.processEvents()
            h = card.height()
            if h != prev:
                heights.append(h)
                prev = h
        self.assertTrue(heights)
        self.assertGreater(heights[-1], heights[0])
        self.assertEqual(heights, sorted(heights), '流式期间高度应只增不减: %s' % heights)


if __name__ == '__main__':
    unittest.main()
