# coding:utf-8

import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from audio_resource_coordinator import AudioResourceCoordinator
from voice_controller import WAKE_WORD_RETRY_DELAY_MS, VoiceController


class PetVoiceRecordingTimeoutTest(unittest.TestCase):
    def make_controller(self):
        app = Mock()
        app.is_quitting = False
        app.quick_chat_worker = None
        app.pet.reply_card_anchor.return_value = (100, 200)
        resources = AudioResourceCoordinator()
        resources.try_acquire('voice_chat')
        controller = VoiceController(app, Mock(), Mock(), audio_resources=resources)
        controller.active = True
        controller.listening = True
        controller.last_text = ''
        return controller, app, resources

    def test_timeout_submits_latest_interim_text_once(self):
        controller, app, _resources = self.make_controller()
        controller.last_text = '已经识别的内容'

        controller._on_recording_timeout()

        self.assertFalse(controller.listening)
        controller._submit.assert_called_once_with('已经识别的内容', '')
        app.note.setup_reply_card_text.assert_called_once()
        self.assertIn('继续处理已识别内容', app.note.setup_reply_card_text.call_args.args[0])

    def test_timeout_without_text_returns_to_existing_voice_state(self):
        controller, app, _resources = self.make_controller()

        controller._on_recording_timeout()

        self.assertFalse(controller.listening)
        controller._submit.assert_not_called()
        app.note.setup_reply_card_text.assert_called_once()
        self.assertIn('未识别到可发送的内容', app.note.setup_reply_card_text.call_args.args[0])

    @patch('voice_controller.AsrWorker')
    def test_wake_error_schedules_retry_then_rebuilds(self, asr_worker):
        """唤醒词监听失败后 30 秒重试；期间关闭或已恢复则不重建。"""
        controller, app, _resources = self.make_controller()
        controller._wake_retry_timer = Mock()

        controller._on_wake_error('麦克风被独占')
        controller._wake_retry_timer.start.assert_called_once_with(WAKE_WORD_RETRY_DELAY_MS)

        controller.apply_wake_word_settings = Mock()
        with patch('voice_controller.config') as cfg:
            cfg.wake_word_config = {'enabled': True}
            controller._retry_wake_word()
        controller.apply_wake_word_settings.assert_called_once()

        # 监听已自行恢复（worker 存在）时不重复重建
        controller.apply_wake_word_settings.reset_mock()
        controller._wake_word_worker = Mock()
        controller._retry_wake_word()
        controller.apply_wake_word_settings.assert_not_called()

    def test_wake_hit_while_reply_streaming_resumes_listener(self):
        """回复生成中喊唤醒词：不得吞掉命中，需恢复监听并给出提示。"""
        controller, app, _resources = self.make_controller()
        app.quick_chat_worker = Mock()  # 上一条回复仍在生成
        app.pet.show_voice_popup = Mock()
        controller.listening = False   # 未在录音，唤醒才可能命中
        controller.waiting_reply = False
        controller._resume_wake_word = Mock()

        controller.start_once('wake_word')

        controller._resume_wake_word.assert_called_once()
        app.pet.update_voice_popup.assert_called_once_with(
            'thinking', '上一句还没回完，稍等再喊我～')
        self.assertFalse(controller.listening)

    def test_stale_timeout_has_no_effect(self):
        controller, app, _resources = self.make_controller()
        controller.listening = False

        controller._on_recording_timeout()

        controller._submit.assert_not_called()
        app.note.setup_reply_card_text.assert_not_called()

    @patch('voice_controller.AsrWorker')
    def test_old_worker_late_results_cannot_pollute_new_round(self, asr_worker):
        """A 轮 final 后必须结束该轮；A 的延迟回调不得污染 B 轮。"""
        controller, app, _resources = self.make_controller()
        worker_a = Mock()
        worker_a.isRunning.return_value = True
        controller._asr_worker = worker_a

        # A 轮收到 final：提交一次，worker_a 被 finish 并隔离；不再预建 standby
        controller._on_asr_final(worker_a, '第一句')
        controller._submit.assert_called_once_with('第一句', '')
        worker_a.finish.assert_called_once()
        self.assertIsNone(controller._asr_worker)
        self.assertIn(worker_a, controller._closing_asr_workers)

        # B 轮按需新建 worker（不是旧 worker_a）
        controller.waiting_reply = False
        controller.start_recording()
        self.assertIsNot(controller._asr_worker, worker_a)
        self.assertIsNotNone(controller._asr_worker)

        # A 的延迟回包一律丢弃，不影响 B 轮
        controller._on_asr_text(worker_a, '旧中间结果')
        self.assertEqual('', controller.last_text)
        controller._on_asr_final(worker_a, '旧最终结果')
        controller._submit.assert_called_once_with('第一句', '')
        controller._on_asr_error(worker_a, '旧错误')
        self.assertTrue(controller.active)


if __name__ == '__main__':
    unittest.main()
