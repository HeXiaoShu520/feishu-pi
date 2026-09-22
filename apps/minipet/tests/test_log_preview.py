# coding:utf-8

import unittest

from src.clients.log_preview import log_preview


class LogPreviewTest(unittest.TestCase):
    def test_keeps_short_text(self):
        self.assertEqual('hello', log_preview('hello'))

    def test_flattens_newlines(self):
        self.assertEqual('first\\nsecond', log_preview('first\nsecond'))

    def test_truncates_long_text(self):
        self.assertEqual('abcd... [已省略 2 字符]', log_preview('abcdef', limit=4))


if __name__ == '__main__':
    unittest.main()
