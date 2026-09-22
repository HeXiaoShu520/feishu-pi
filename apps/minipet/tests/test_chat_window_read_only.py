# coding:utf-8
"""聊天窗是历史查看器，不能重新长出输入或清空通路。"""

import inspect
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from pet.desktop_windows import show_chat_window
from windows.chat_window import ChatWindow


class ChatWindowReadOnlyTest(unittest.TestCase):

    def test_viewer_has_no_mutating_chat_api(self):
        self.assertNotIn('_send', ChatWindow.__dict__)
        self.assertNotIn('clear_history', ChatWindow.__dict__)
        source = Path(inspect.getsourcefile(ChatWindow)).read_text(encoding='utf-8')
        self.assertNotIn('class ChatInput', source)
        self.assertNotIn('send_callback', source)
        self.assertNotIn('clear_history_callback', source)

    def test_window_factory_accepts_history_only(self):
        self.assertEqual(['owner', 'history'], list(inspect.signature(show_chat_window).parameters))


if __name__ == '__main__':
    unittest.main()
