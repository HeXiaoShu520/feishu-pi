# coding:utf-8
"""打字机节奏回归测试：流式积压时不得低于可读速度下限。"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from PySide6.QtWidgets import QApplication, QLabel

from typewriter import Typewriter


class TypewriterPacingTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def _label(self):
        from PySide6.QtCore import Qt
        label = QLabel()
        label.setTextFormat(Qt.RichText)  # 与回复卡片一致
        return label

    def test_small_reply_keeps_configured_speed(self):
        tw = Typewriter(self._label())
        tw.typewrite('字' * 100)
        self.assertEqual(28, tw._calc_interval())

    def test_large_backlog_accelerates_to_meet_max_duration(self):
        """长文本按 max_duration 加速：500 字积压时约 10ms/字（不低于 8ms）"""
        tw = Typewriter(self._label())
        tw.typewrite('字' * 500)
        self.assertEqual(10, tw._calc_interval())
        tw._shown = 300
        ideal = 5000 // 200
        self.assertEqual(max(8, min(28, ideal)), tw._calc_interval())

    def test_append_chunk_backlog_also_respects_floor(self):
        """流式 append_chunk 场景：目标持续增长时同样不突破下限。"""
        tw = Typewriter(self._label())
        for _ in range(10):
            tw.append_chunk('字' * 50)  # 500 字积压
        self.assertEqual(10, tw._calc_interval())

    def test_tick_never_cuts_inside_html_tag(self):
        """跨 <br> 等标签推进时，切点必须跳过整个标签，避免换行瞬间消失抖动"""
        tw = Typewriter(self._label())
        tw.typewrite('第一段。<br>第二段。')
        cuts = []
        for _ in range(200):
            if tw._shown >= len(tw._target):
                break
            tw._tick()
            cuts.append(tw._target[:tw._shown])
            if not tw._timer.isActive():
                break
        self.assertEqual(len(tw._target), tw._shown)
        for cut in cuts:
            lt = cut.rfind('<')
            if lt != -1:
                self.assertIn('>', cut[lt:], '切点落在标签内部: %r' % cut)


if __name__ == '__main__':
    unittest.main()
