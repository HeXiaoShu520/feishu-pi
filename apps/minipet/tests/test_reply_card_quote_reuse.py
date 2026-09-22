# coding:utf-8
"""引用追问的卡片复用回归测试：ID 必须锚定原卡片，思考期不得清空正文。"""

import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

import app as app_module
from app import MiniPetApp


class ReplyCardQuoteReuseTest(unittest.TestCase):
    def _make_app(self):
        app = Mock(spec=MiniPetApp)
        app._agent_backend.return_value = 'minipet'
        app.note = Mock()
        app._append_chat_message = Mock()
        app._begin_turn = Mock()
        app._backend_session_id = Mock(return_value='minipet:global')
        app._reset_quick_stream_tts = Mock()
        app._build_quick_chat_messages = Mock(return_value=[])
        return app

    def test_quote_keeps_same_card_id_and_body(self):
        """引用追问锚定原卡片 ID；思考态只更新状态字段，不带 content 清空正文。"""
        app = self._make_app()
        app._send_external_command = Mock()

        MiniPetApp._on_reply_card_quote(app, 'card-1', '继续聊',
                                        quoted_text='旧回复', user_text='继续聊')

        app.note.update_reply_card.assert_called_once_with(
            'card-1', {'status': 'thinking', 'timeout_ms': 0}, timeout=0,
        )
        self.assertTrue(app._reuse_reply_card_pending)
        self.assertTrue(app._reply_card_permanent)
        self.assertIs(app.quick_reply_card_id, 'card-1')

        # 连续追问：仍然锚定同一张卡片，不新建
        app.note.update_reply_card.reset_mock()
        MiniPetApp._on_reply_card_quote(app, 'card-1', '再来',
                                        quoted_text='', user_text='再来')
        app.note.update_reply_card.assert_called_once_with(
            'card-1', {'status': 'thinking', 'timeout_ms': 0}, timeout=0,
        )

    def test_streaming_reply_reuses_quoted_card(self):
        """回复流发布时复用原卡片 ID，绝不另建新卡片。"""
        app = self._make_app()
        app.quick_reply_card_id = 'card-1'
        app.pet = Mock()
        app.pet.reply_card_anchor.return_value = (100, 200)
        app.note.update_reply_card.return_value = True
        app._reply_card_timeout = Mock(return_value=0)
        app._quick_reply_usage = None

        MiniPetApp._show_reply_card(app, '新回复', status='done')

        args = app.note.update_reply_card.call_args
        self.assertEqual('card-1', args.args[0])
        app.note.setup_reply_card.assert_not_called()

    def test_external_input_is_sent_to_minipet(self):
        app = self._make_app()
        app._resolve_turn = Mock(return_value=None)
        app._begin_turn.return_value = Mock(origin='external', turn_id='turn-1', surface_id='surface-1')
        app._begin_reply_card_turn = Mock()
        app._reset_external_stream_tts = Mock()
        app._show_reply_card = Mock()
        app._finish_turn = Mock()
        app.router = Mock()
        app.router.send.return_value = True

        sent = MiniPetApp._send_external_command(app, '你好呀', 'text', 'pet_popup')

        self.assertTrue(sent)
        app.router.send.assert_called_once()
        self.assertEqual('你好呀', app.router.send.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
