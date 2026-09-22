# coding:utf-8
"""
语音聊天控制器。

把 MiniPetApp 中所有语音相关逻辑提取到这里集中管理，包括：
- ASR 录音启停（本地 AI 语音聊天，不含豆包通话）
- 唤醒词检测：启动/暂停/恢复/停止 SherpaKwsWorker（sherpa-onnx 神经网络 KWS）
- 语音球 UI 状态：idle / listening / thinking / speaking / error
- 连续对话控制：一轮结束后决定是否自动开启下一轮
- 屏幕共享截图：语音输入时附加截图给 mini-claw 内核

外部依赖（通过 __init__ 注入）：
- app：MiniPetApp 实例，提供 pet、note、quick_stream_tts、external_stream_tts
- submit_voice_text(text)：文字确认后的提交回调（由 MiniPetApp 提供）
- stop_all_tts()：终止所有 TTS 播放（由 MiniPetApp 提供）
"""

import random

from PySide6.QtCore import QObject, QTimer
from PySide6.QtWidgets import QApplication

import config
from clients.asr_client import AsrWorker
from clients.asr_round_pool import AsrRoundPool
from clients.kws_client import SherpaKwsWorker
from clients.tts_client import TtsPreviewWorker, stop_tts
from log_util import get_logger

log = get_logger('voice.chat')

# 唤醒词监听失败后的自动重试间隔（麦克风被独占、依赖缺失等场景）
WAKE_WORD_RETRY_DELAY_MS = 30000

# 唤醒确认音文件名枚举（随机选一个播放）
_WAKE_ACK_KEYS = ('wake_ack_1', 'wake_ack_2', 'wake_ack_3', 'wake_ack_4')


class VoiceController(QObject):
    """
    本地 AI 语音聊天控制器。

    生命周期：
    1. open()  → 显示语音球，进入 idle / wakeup 状态
    2. start_recording()  → 开始 ASR 录音，显示 listening
    3. ASR final → submit_voice_text() 回调 → 进入 thinking 状态
    4. TTS 结束 → _finish_voice_turn() → 返回步骤 2 或关闭
    5. stop()  → 完全关闭，释放所有资源
    """

    def __init__(self, app, submit_voice_text, stop_all_tts, audio_resources=None, parent=None):
        super().__init__(parent)
        self._app = app            # MiniPetApp
        self._audio_resources = audio_resources
        self._submit = submit_voice_text
        self._stop_all_tts = stop_all_tts

        # 语音状态
        self.active = False
        self.listening = False
        self.waiting_reply = False
        self.paused = False
        self.paused_stage = 'idle'
        self.last_text = ''
        self.shared_screen = None  # 屏幕共享时指向 QScreen

        # 工作线程：ASR worker 生命周期统一交给轮次池（standby/closing/身份过滤）
        self._pool = AsrRoundPool(
            worker_factory=lambda parent: AsrWorker(parent=parent),
            handlers={
                'status': self._on_asr_status,
                'text': self._on_asr_text,
                'final': self._on_asr_final,
                'error': self._on_asr_error,
                'finished': self._on_asr_finished,
            },
            parent=self,
        )
        self._wake_word_worker = None
        self._wake_ack_worker = None
        # 录音超时定时器（最长 5 分钟）
        self._record_timeout = QTimer(self)
        self._record_timeout.setSingleShot(True)
        self._record_timeout.timeout.connect(self._on_recording_timeout)
        # 唤醒词监听失败后的重试定时器
        self._wake_retry_timer = QTimer(self)
        self._wake_retry_timer.setSingleShot(True)
        self._wake_retry_timer.timeout.connect(self._retry_wake_word)

    # 兼容属性：worker 真实状态存于轮次池，这里只做读写转发
    @property
    def _asr_worker(self):
        """当前活跃 ASR worker（可能是待命的 standby）。"""
        return self._pool.active_worker

    @_asr_worker.setter
    def _asr_worker(self, worker):
        self._pool.set_active(worker)

    @property
    def _closing_asr_workers(self):
        """closing 集合快照（实际状态存于轮次池）。"""
        return self._pool.closing_workers

    # ------------------------------------------------------------------
    # 公开入口
    # ------------------------------------------------------------------


    # ==== 公开接口 ====
    def open(self):
        """打开语音球（单次触发，不做连续对话控制）。"""
        self._app.pet.show_voice_popup()
        if not config.tts_config.get('enabled'):
            self._app.pet.update_voice_popup('error', '语音功能未开启')
            QTimer.singleShot(1800, self._app.pet.close_voice_popup)
            return
        if not config.tts_config.get('api_key'):
            self._app.pet.update_voice_popup('error', '缺少语音配置')
            QTimer.singleShot(1800, self._app.pet.close_voice_popup)
            return
        self.active = True
        self.waiting_reply = False
        self.paused = False
        self._app.pet.set_voice_chat_active(True)
        state = 'wakeup' if self._wake_word_enabled() else 'idle'
        self._app.pet.update_voice_popup(state, '')
        if self._wake_word_enabled():
            self.apply_wake_word_settings()

    def _back_to_wakeup(self):
        """提示语展示结束后回到唤醒待机动画（仍在语音会话且未在录音时）。"""
        if self.active and not self.listening and not self.waiting_reply and self._wake_word_enabled():
            self._app.pet.update_voice_popup('wakeup', '')

    def start_once(self, trigger='menu'):
        """启动一次 ASR 接听，后续是否继续由连续对话开关决定。"""
        if self.active:
            self._app.pet.show_voice_popup()
            if trigger == 'wake_word' and not self.listening and not self.waiting_reply:
                if self._app.quick_chat_worker is not None:
                    # 上一条回复仍在生成，无法开始录音：恢复监听并给出提示。
                    # 否则唤醒命中被吞掉后监听停在暂停状态，之后喊词再无响应。
                    log.info('唤醒命中但上一条回复仍在生成，已恢复监听等待下次唤醒')
                    self._app.pet.update_voice_popup('thinking', '上一句还没回完，稍等再喊我～')
                    QTimer.singleShot(2500, self._back_to_wakeup)
                    self._resume_wake_word()
                    return
                self._pause_wake_word()
                self.start_recording()
            return
        self.open()
        if not self.active:
            return
        # 如果唤醒词模式且本次不是唤醒词触发，回到等待唤醒状态
        if self._wake_word_enabled() and trigger != 'wake_word':
            self._app.pet.update_voice_popup('wakeup', '')
            self.apply_wake_word_settings()
            return
        self._pause_wake_word()
        self.start_recording()

    def start_recording(self):
        """开始麦克风录音（ASR）。"""
        if not self.active or self.paused or self._app.quick_chat_worker is not None or self.waiting_reply:
            log.info('录音未进入 active=%s paused=%s listening=%s waiting_reply=%s', self.active, self.paused, self.listening, self.waiting_reply)
            return
        trigger = getattr(self._app, 'quick_chat_source', None) or 'voice_chat'
        log.info('进入录音状态 trigger=%s', trigger)
        if self._audio_resources is not None and not self._audio_resources.try_acquire('voice_chat'):
            log.info('麦克风正在使用，跳过语音聊天录音')
            return
        self.listening = True
        self.last_text = ''

        # 轮次池负责 standby 复用与按下即采；SAUC 一条连接只服务一轮
        self._pool.start_recording(self)
        # 直连握手约 200ms，连接动画默认屏蔽；冷连接期间麦克风尚未采集，
        # 握手完成收到"ASR已连接"后自动进入 listening
        worker = self._pool.active_worker
        if (config.ASR_CONNECTING_ANIMATION
                and worker is not None and not worker.is_connected()):
            self._app.pet.update_voice_popup('connecting', '正在连接语音服务…')
        else:
            self._app.pet.update_voice_popup('listening', '')
        self._record_timeout.start(config.ASR_RECORDING_MAX_MS)

    def _release_audio(self):
        """释放菜单语音聊天占用的主动录音资源。"""
        if self._audio_resources is not None:
            self._audio_resources.release('voice_chat')

    def stop_recording(self, finish_round=False):
        """停止 ASR 录音；结束轮次时发送末帧并隔离旧 worker。"""
        log.info('退出录音状态 listening=%s waiting_reply=%s', self.listening, self.waiting_reply)
        self._record_timeout.stop()
        self.listening = False
        if self._pool.active_worker is None:
            self._release_audio()
            return
        if finish_round:
            # 本轮已结束；直连握手很快，不再预建下一轮 standby
            self._pool.finish_round(self)
            self._release_audio()
            return
        self._pool.stop_capture()

    def _finish_asr_round(self):
        """结束当前识别轮次，禁止其延迟回包进入下一轮。"""
        self.stop_recording(finish_round=True)

    def pause(self):
        """暂停：停止录音和 TTS，但保留语音球（单击可继续）。"""
        print('[VoiceController] %s语音交互 active=%s listening=%s waiting_reply=%s' % ('恢复' if self.paused else '暂停', self.active, self.listening, self.waiting_reply), flush=True)
        if not self.active:
            return
        if self.paused:
            # 已暂停 → 恢复
            self.paused = False
            if self.paused_stage == 'wakeup':
                self._app.pet.update_voice_popup('wakeup', '')
                self._resume_wake_word()
            else:
                self.start_recording()
            self.paused_stage = 'idle'
            return

        self.paused = True
        # 记录暂停时所处阶段，恢复时还原到正确状态
        if (self.listening or self.waiting_reply
                or self._app.quick_stream_tts.is_active()
                or self._app.external_stream_tts.is_active()
                or self._wake_ack_worker is not None):
            self.paused_stage = 'recording'
        elif self._wake_word_enabled():
            self.paused_stage = 'wakeup'
        else:
            self.paused_stage = 'recording'

        self._pause_wake_word()
        self._finish_asr_round()
        self._stop_all_tts()
        self._app._cancel_current_reply_workers()
        self._app.quick_stream_tts.reset()
        self._app.external_stream_tts.reset()
        self.waiting_reply = False
        self._app.pet.update_voice_popup('idle', '已暂停，单击继续')
        QTimer.singleShot(1600, self._shrink_paused_popup)

    def stop(self):
        """完全停止语音聊天，释放所有资源。"""
        log.info('退出语音交互 active=%s listening=%s waiting_reply=%s paused=%s', self.active, self.listening, self.waiting_reply, self.paused)
        self._record_timeout.stop()
        self._wake_retry_timer.stop()
        self.last_text = ''
        self.active = False
        self.listening = False
        self._release_audio()
        self.waiting_reply = False
        self.paused = False
        self.paused_stage = 'idle'
        self.shared_screen = None

        self._stop_wake_word()
        self._pool.shutdown()
        if self._wake_ack_worker is not None:
            self._wake_ack_pending_start = False
            stop_tts()
            self._wake_ack_worker.wait(1200)
            self._wake_ack_worker = None

        self._app.pet.set_voice_chat_active(False)
        self._app.pet.close_voice_popup()
        if not self._app.is_quitting:
            delay = int(config.wake_word_config.get('restart_delay_ms') or 1200)
            QTimer.singleShot(delay, self._resume_wake_word)

    def set_screen_share(self, enabled):
        """开关屏幕共享（语音输入时附加截图给 mini-claw 内核）。"""
        if not config.SCREEN_SHARE_ENABLED:
            self.shared_screen = None
            return
        self.shared_screen = QApplication.primaryScreen() if enabled else None

    def capture_screenshot(self):
        """返回当前屏幕截图的 base64 data URL，未开启共享时返回空字符串。"""
        if not config.SCREEN_SHARE_ENABLED or self.shared_screen is None:
            return ''
        import base64
        from PySide6.QtCore import QBuffer, QByteArray, QIODevice, Qt as _Qt
        pixmap = self.shared_screen.grabWindow(0)
        if pixmap.isNull():
            return ''
        image = pixmap.toImage()
        if image.width() > 1280:
            image = image.scaledToWidth(1280, _Qt.SmoothTransformation)
        data = QByteArray()
        buf = QBuffer(data)
        buf.open(QIODevice.WriteOnly)
        image.save(buf, 'JPEG', 85)
        return 'data:image/jpeg;base64,' + base64.b64encode(bytes(data)).decode('ascii')

    def finish_turn(self, delay_ms=500):
        """
        一轮对话结束后调用：重置等待状态，根据连续对话开关决定下一步。
        - 连续对话：延迟后自动开始录音
        - 唤醒词模式：回到等待唤醒状态
        - 普通模式：显示 idle
        """
        log.info('轮次收尾: continuous=%s wake=%s (TTS active=%s)',
                 config.voice_chat_config.get('continuous', False),
                 self._wake_word_enabled(),
                 self._app.quick_stream_tts.is_active())
        self.waiting_reply = False
        if not self.active or self.paused:
            return
        if config.voice_chat_config.get('continuous', False):
            self._app.pet.update_voice_popup('listening', '')
            QTimer.singleShot(delay_ms, self.start_recording)
            return
        self.paused = False
        if self._wake_word_enabled():
            self._app.pet.update_voice_popup('wakeup', '')
            restart_delay = int(config.wake_word_config.get('restart_delay_ms') or 1200)
            QTimer.singleShot(restart_delay, self._resume_wake_word)
        else:
            self._app.pet.update_voice_popup('idle', '')

    # ------------------------------------------------------------------
    # 唤醒词管理
    # ------------------------------------------------------------------


    # ==== 唤醒词管理 ====
    def apply_wake_word_settings(self):
        """按当前配置启动或重建唤醒词监听线程。

        每次都重建而不是复用旧线程：唤醒词等配置在 KWS 引擎创建时读取，
        设置变更后必须重建才能生效。
        """
        if not self._wake_word_enabled():
            self._stop_wake_word()
            return
        self._stop_wake_word()
        # 神经网络 KWS 唤醒（sherpa-onnx）；模型缺失时 Worker 会给出下载提示
        self._wake_word_worker = SherpaKwsWorker(
            config.wake_word_config, root_dir=config.ROOT_DIR, parent=self,
        )
        self._wake_word_worker.detected.connect(self._on_wake_detected)
        self._wake_word_worker.status_changed.connect(self._on_wake_status)
        self._wake_word_worker.error_received.connect(self._on_wake_error)
        self._wake_word_worker.finished.connect(self._on_wake_finished)
        self._wake_word_worker.start()

    # ------------------------------------------------------------------
    # 内部实现
    # ------------------------------------------------------------------


    # ==== 内部辅助 ====
    def _wake_word_enabled(self):
        return self.active and bool(config.wake_word_config.get('enabled', False))

    def _pause_wake_word(self):
        if self._wake_word_worker is not None:
            log.info('唤醒词监听暂停')
            self._wake_word_worker.pause()

    def _resume_wake_word(self):
        if not self._wake_word_enabled() or self.listening or self.waiting_reply:
            return
        if self._wake_word_worker is not None and self._wake_word_worker.isRunning():
            self._wake_word_worker.resume()
        else:
            self.apply_wake_word_settings()

    def _stop_wake_word(self):
        if self._wake_word_worker is None:
            return
        self._wake_word_worker.stop()
        self._wake_word_worker.wait(1200)
        self._wake_word_worker = None

    def _shrink_paused_popup(self):
        """暂停提示显示 1.6s 后收缩成 idle 小球。"""
        if self.active and self.paused:
            self._app.pet.update_voice_popup('idle', '')

    def _wake_ack_sound_path(self):
        """返回随机一条唤醒确认音路径，文件不存在时返回 None。"""
        voice_name = config.tts_config.get('voice_name') or config.DEFAULT_TTS_CONFIG['voice_name']
        safe_voice = ''.join(ch if ch.isalnum() or ch in ('-', '_') else '_' for ch in voice_name).strip('_') or 'default'
        key = random.choice(_WAKE_ACK_KEYS)
        path = config.DATA_DIR / 'tts_wake_ack' / safe_voice / (key + '.wav')
        return path if path.is_file() else None

    def _play_wake_ack_then_start(self):
        """唤醒后先播一段确认音，再开始录音。"""
        if not self.active or self._wake_ack_worker is not None:
            return
        self._wake_ack_pending_start = True
        self._app.pet.update_voice_popup('thinking', '')
        path = self._wake_ack_sound_path()
        if path is None:
            self._finish_wake_ack()
            return
        stop_tts()
        self._app.quick_stream_tts.reset()
        self._app.external_stream_tts.reset()
        self._wake_ack_worker = TtsPreviewWorker(path, parent=self)
        self._wake_ack_worker.result_ready.connect(self._on_wake_ack_done)
        self._wake_ack_worker.start()

    def _finish_wake_ack(self):
        if self._wake_ack_pending_start and self.active and not self.paused:
            self._wake_ack_pending_start = False
            self.start_once('wake_word')

    # ------------------------------------------------------------------
    # ASR 回调
    # ------------------------------------------------------------------


    # ==== ASR 回调 ====
    def _on_asr_status(self, worker, text):
        """ASR 连接状态变更（仅在当前录音且未等待回复时更新 UI）。"""
        if (worker is self._asr_worker and self.active and not self.paused and not self.waiting_reply
                and text in ('ASR已连接', '正在识别')
                and self._app.quick_chat_worker is None
                and not self._app.quick_stream_tts.is_active()
                and not self._app.external_stream_tts.is_active()):
            # 'ASR已连接' 到达时把 connecting 动画切回 listening；热连接路径状态不变
            self._app.pet.update_voice_popup('listening', '')

    def _on_asr_text(self, worker, text):
        """ASR 中间识别结果（仅接受当前录音）。"""
        if (worker is self._asr_worker and self.active and not self.paused and not self.waiting_reply
                and text
                and self._app.quick_chat_worker is None
                and not self._app.quick_stream_tts.is_active()
                and not self._app.external_stream_tts.is_active()):
            self.last_text = str(text).strip()
            self._app.pet.update_voice_popup('listening', text)

    def _on_asr_final(self, worker, text):
        """ASR 最终识别结果：只处理当前录音。"""
        text = (text or '').strip()
        if worker is not self._asr_worker:
            return
        if not text or not self.active or self.paused or self.waiting_reply:
            return
        self._finish_asr_round()
        self.last_text = ''
        self.waiting_reply = True
        self._app.pet.update_voice_popup('thinking', text)
        screenshot = self.capture_screenshot()
        self._submit(text, screenshot)

    def _on_asr_error(self, worker, text):
        """ASR 出错：standby 空闲死亡静默废弃；仅当前录音错误才提示并关闭。"""
        if not self._pool.is_active(worker):
            return
        if not self.listening:
            # standby 未参与录音时被服务端空闲超时关闭属正常现象，静默废弃即可。
            log.info('standby 连接失效，静默废弃: %s', text)
            self._pool.discard_active()
            return
        if self.active:
            self._app.pet.update_voice_popup('error', str(text)[:60])
            x, y = self._app.pet.reply_card_anchor()
            self._app.note.setup_reply_card_text(
                '语音识别出错：' + str(text), x, y, 5000,
                title=config.pet_display_name()
            )
        self.stop()

    def _on_asr_finished(self, worker, branch):
        """清理结束的 worker；closing 轮不会影响当前录音状态。"""
        if branch == 'active':
            self._record_timeout.stop()
            self._release_audio()
            self.last_text = ''

    def _on_recording_timeout(self):
        """录音超时（5分钟）：有文字就提交，没有就提示并结束。"""
        if not self.active or self.paused or not self.listening or self.waiting_reply:
            return
        text = self.last_text.strip()
        self._finish_asr_round()
        x, y = self._app.pet.reply_card_anchor()
        if text:
            self._app.note.setup_reply_card_text(
                '语音录制已达到 5 分钟，已自动结束，并继续处理已识别内容。',
                x, y, 5000, title=config.pet_display_name(),
            )
            self.waiting_reply = True
            self._app.pet.update_voice_popup('thinking', text)
            screenshot = self.capture_screenshot()
            self._submit(text, screenshot)
            return
        self._app.note.setup_reply_card_text(
            '语音录制已达到 5 分钟，已自动结束；未识别到可发送的内容。',
            x, y, 5000, title=config.pet_display_name(),
        )
        self.finish_turn(delay_ms=0)

    # ------------------------------------------------------------------
    # 唤醒词回调
    # ------------------------------------------------------------------


    # ==== 唤醒词回调 ====
    def _on_wake_detected(self, text):
        """检测到唤醒词：暂停监听，播放确认音，然后开始录音。"""
        if self._app.is_quitting or not self.active or self.listening or self.waiting_reply:
            return
        self._pause_wake_word()
        self._play_wake_ack_then_start()

    def _on_wake_ack_done(self, success, text):
        if not success:
            log.warning('唤醒确认音播放失败: %s', text)
        self._wake_ack_worker = None
        self._finish_wake_ack()

    def _on_wake_status(self, text):
        if text and text not in ('等待唤醒词',):
            log.info('唤醒词监听: %s', text)

    def _on_wake_error(self, text):
        # 应用退出期间的设备关闭竞态（如 PortAudio 已随应用关闭）属正常现象
        if self._app.is_quitting:
            log.info('唤醒词监听随应用退出关闭（%s）', text)
            self._wake_word_worker = None
            return
        log.warning('唤醒词监听错误: %s', text)
        self._wake_word_worker = None
        # 麦克风被独占、依赖缺失等场景：30 秒后自动重试，直到抢到麦或功能被关闭
        if self.active:
            self._wake_retry_timer.start(WAKE_WORD_RETRY_DELAY_MS)

    def _retry_wake_word(self):
        """重试重建唤醒词监听；期间语音已关闭或监听已自行恢复时不做任何事。"""
        if self._wake_word_enabled() and self._wake_word_worker is None:
            log.info('唤醒词监听重试')
            self.apply_wake_word_settings()

    def _on_wake_finished(self):
        self._wake_word_worker = None
