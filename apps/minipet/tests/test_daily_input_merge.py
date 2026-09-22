# coding:utf-8
"""语音输入 final 文本合并回归测试：标点差异与重叠不得造成翻倍。"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from daily_input_controller import merge_asr_text


class MergeAsrTextTest(unittest.TestCase):

    def test_identical_with_punct_is_not_doubled(self):
        """临时识别'好久不见' + final'好久不见。'不得变成'好久不见好久不见。'"""
        self.assertEqual('好久不见。', merge_asr_text('好久不见', '好久不见。'))

    def test_exact_duplicate_unchanged(self):
        self.assertEqual('好久不见', merge_asr_text('好久不见', '好久不见'))

    def test_identical_redelivery_with_trailing_punct_no_double_punct(self):
        """final 原样重发整句（含句号）时，不得多出一个句号"""
        text = '朝阳起又落呃，朝阳起又落。'
        self.assertEqual(text, merge_asr_text(text, text))

    def test_partial_overlap_appends_only_new_tail(self):
        """临时'好久不' + final'好久不见。'应只补上'见。'"""
        self.assertEqual('好久不见。', merge_asr_text('好久不', '好久不见。'))

    def test_extension_appends_punctuated_tail(self):
        """final 在临时文本基础上延长：保留新增部分及标点"""
        self.assertEqual('好久不见，我想你了', merge_asr_text('好久不见', '好久不见，我想你了'))

    def test_genuinely_new_text_concatenates(self):
        self.assertEqual('你好今天天气不错', merge_asr_text('你好', '今天天气不错'))

    def test_final_contained_in_current_unchanged(self):
        self.assertEqual('好久不见', merge_asr_text('好久不见', '不见'))

    def test_empty_sides(self):
        self.assertEqual('你好', merge_asr_text('', '你好'))
        self.assertEqual('你好', merge_asr_text('你好', ''))
        self.assertEqual('', merge_asr_text('', ''))

    def test_emoji_and_symbols_ignored_in_compare(self):
        """含表情/波浪线的文本按去标点后的内容对比；原文标点保留"""
        self.assertEqual('想你呀🥰～', merge_asr_text('想你呀', '想你呀🥰～'))


if __name__ == '__main__':
    unittest.main()
