# coding:utf-8

import sys
import unittest
from pathlib import Path
from unittest.mock import ANY, Mock, patch

from PySide6.QtWidgets import QApplication

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from audio_resource_coordinator import AudioResourceCoordinator
from clients.middle_btn_listener import MiddleButtonListener
from daily_input_controller import DailyInputController
from widgets.pet_voice_popup import VoiceOrbWidget


class DailyInputAnchorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.qt_app = QApplication.instance() or QApplication([])

    def make_controller(self, audio_resources=None):
        app = Mock()
        app.pet.reply_card_anchor.return_value = (480, 240)
        controller = DailyInputController(app=app, audio_resources=audio_resources)
        return controller, app

    def test_initial_voice_orb_content_has_final_width_without_animation(self):
        orb = VoiceOrbWidget()
        orb.set_initial_content('typing', '语音输入中')
        self.assertEqual('typing', orb.state)
        self.assertEqual('语音输入中', orb.text)
        self.assertGreater(orb.width(), orb.min_orb_width)
        self.assertIsNone(orb.width_anim)
        orb.set_text('这是更长的识别文本')
        self.assertIsNotNone(orb.width_anim)

    def test_middle_listener_emits_toggle(self):
        listener = MiddleButtonListener()
        received = []
        listener.toggled.connect(lambda x, y: received.append(True))
        listener.toggled.emit(10, 20)
        self.assertEqual([True], received)

    @patch('daily_input_controller.QTimer.singleShot')
    @patch('daily_input_controller.AsrWorker')
    @patch('daily_input_controller.config.tts_config', {'api_key': 'test'})
    def test_recognition_does_not_touch_voice_popup(self, asr_worker, single_shot):
        resources = AudioResourceCoordinator()
        controller, app = self.make_controller(resources)
        worker = Mock()
        worker.isRunning.return_value = True
        asr_worker.return_value = worker
        controller._on_middle_btn_toggled()
        controller._on_text_received(worker, '正在识别')
        controller._on_final_received(worker, '完成')
        app.pet.update_voice_popup.assert_not_called()
        app.pet.close_voice_popup.assert_not_called()
        self.assertEqual('daily_input', resources.owner)

    @patch('daily_input_controller.QTimer.singleShot')
    @patch('daily_input_controller.AsrWorker')
    @patch('daily_input_controller.config.tts_config', {'api_key': 'test'})
    def test_stop_releases_audio_resource(self, asr_worker, single_shot):
        resources = AudioResourceCoordinator()
        controller, _app = self.make_controller(resources)
        worker = Mock()
        worker.isRunning.return_value = True
        asr_worker.return_value = worker
        controller._start_recording()
        controller._stop_recording()
        self.assertEqual('daily_input', resources.owner)
        controller._on_asr_finished(worker, 'closing')
        self.assertEqual('', resources.owner)
        worker.finish.assert_called_once_with()

    @patch('daily_input_controller.config.tts_config', {'api_key': 'test'})
    def test_busy_audio_resource_rejects_recording(self):
        resources = AudioResourceCoordinator()
        self.assertTrue(resources.try_acquire('voice_chat'))
        controller, app = self.make_controller(resources)
        controller._start_recording()
        self.assertFalse(controller._recording)
        self.assertIsNone(controller._asr_worker)
        app.pet.update_voice_popup.assert_not_called()

    def test_timeout_uses_pet_reply_anchor_without_popup(self):
        resources = AudioResourceCoordinator()
        controller, app = self.make_controller(resources)
        controller._recording = True
        resources.try_acquire('daily_input')
        controller._accumulated_text = '已识别内容'
        controller._on_recording_timeout()
        app.note.setup_reply_card_text.assert_called_once_with(
            ANY, 480, 240, 5000, title=ANY,
        )
        app.pet.update_voice_popup.assert_not_called()
        self.assertEqual('', resources.owner)

    def test_audio_coordinator_allows_reentry_only_for_same_owner(self):
        resources = AudioResourceCoordinator()
        self.assertTrue(resources.try_acquire('daily_input'))
        self.assertTrue(resources.try_acquire('daily_input'))
        self.assertFalse(resources.try_acquire('voice_chat'))
        self.assertTrue(resources.release('daily_input'))
        self.assertEqual('', resources.owner)

    @patch('daily_input_controller.QTimer.singleShot')
    @patch('daily_input_controller.AsrWorker')
    @patch('daily_input_controller.config.tts_config', {'api_key': 'test'})
    def test_fast_switch_keeps_old_final_out_of_new_round(self, asr_worker, single_shot):
        """快速连续两轮：旧 worker 延迟 final 只能写旧轮状态，不得污染新一轮。"""
        resources = AudioResourceCoordinator()
        controller, _app = self.make_controller(resources)
        worker_a, worker_b = Mock(), Mock()
        worker_a.isRunning.return_value = True
        worker_b.isRunning.return_value = True
        asr_worker.side_effect = [worker_a, worker_b]
        controller._start_recording()
        controller._on_final_received(worker_a, '第一轮')
        controller._stop_recording()
        self.assertIn(worker_a, controller._closing_rounds)
        controller._start_recording()
        controller._on_final_received(worker_a, '补发文字')
        self.assertEqual('', controller._accumulated_text)
        self.assertEqual('第一轮补发文字', controller._closing_rounds[worker_a]['text'])
        controller._on_final_received(worker_b, '第二轮')
        self.assertEqual('第二轮', controller._accumulated_text)

    @patch('daily_input_controller.QTimer.singleShot')
    @patch('daily_input_controller.AsrWorker')
    @patch('daily_input_controller.config.tts_config', {'api_key': 'test'})
    def test_closing_finish_injects_own_text_once(self, asr_worker, single_shot):
        """旧轮收尾完成时，注入的是它自己的文本，且 closing 状态被清理。"""
        resources = AudioResourceCoordinator()
        controller, _app = self.make_controller(resources)
        worker_a, worker_b = Mock(), Mock()
        worker_a.isRunning.return_value = True
        worker_b.isRunning.return_value = True
        asr_worker.side_effect = [worker_a, worker_b]
        controller._start_recording()
        controller._on_final_received(worker_a, '第一轮')
        controller._stop_recording()
        controller._start_recording()
        controller._on_final_received(worker_a, '补发')
        controller._on_asr_finished(worker_a, 'closing')
        self.assertNotIn(worker_a, controller._closing_rounds)
        # 取出收尾排队的注入闭包并执行，验证注入文本属于旧轮 A
        inject_lambda = single_shot.call_args_list[-1].args[1]
        with patch.object(controller, '_inject_text') as inject_mock:
            inject_lambda()
            inject_mock.assert_called_once_with('第一轮补发')

    @patch('daily_input_controller.config.tts_config', {'api_key': 'test'})
    def test_standby_error_is_silent(self):
        """standby 空闲被服务端断开：静默销毁，不提示错误、不结束录音。"""
        resources = AudioResourceCoordinator()
        controller, app = self.make_controller(resources)
        worker = Mock()
        worker.isRunning.return_value = True
        controller._asr_worker = worker
        controller._recording = False
        controller._on_error(worker, 'session has ended')
        self.assertIsNone(controller._asr_worker)
        self.assertFalse(controller._recording)


if __name__ == '__main__':
    unittest.main()
