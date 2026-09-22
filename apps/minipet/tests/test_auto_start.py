# coding:utf-8
"""开机自启注册表读写测试（仅 Windows）。"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from auto_start import is_enabled, set_enabled


@unittest.skipUnless(sys.platform == 'win32', '注册表自启仅支持 Windows')
class AutoStartTest(unittest.TestCase):

    def test_enable_disable_roundtrip(self):
        """开启后注册表应有 MiniPet 条目，关闭后清除。"""
        set_enabled(True)
        self.assertTrue(is_enabled())
        set_enabled(False)
        self.assertFalse(is_enabled())

    def test_disable_is_idempotent(self):
        """未启用时重复关闭不应报错。"""
        set_enabled(False)
        set_enabled(False)
        self.assertFalse(is_enabled())


if __name__ == '__main__':
    unittest.main()
