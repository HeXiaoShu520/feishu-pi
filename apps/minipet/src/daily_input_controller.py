# coding:utf-8
"""日常工作语音输入控制器。

监听鼠标中键：第一次按下开始录音，再次按下停止并把识别结果注入当前焦点输入框。
与语音聊天功能共用麦克风，因此录音期间只暂停唤醒词监听，
录音结束后再恢复；本控制器不触碰语音球和语音聊天状态。

ASR worker 的生命周期（standby 预连接、closing 隔离、身份过滤）统一由
AsrRoundPool 管理，本类只负责输入浮窗 UI 与文字注入的业务逻辑。
"""

import re

from PySide6.QtCore import QObject, QTimer
from PySide6.QtGui import QCursor
from PySide6.QtWidgets import QApplication
import config
from clients.asr_client import AsrWorker
from clients.asr_round_pool import AsrRoundPool
from hotkey_trigger import HotkeyTrigger
from log_util import get_logger

log = get_logger('voice.daily_input')

# ASR 文本对比时忽略的字符：标点和空白不参与重叠计算
_ASR_IGNORE_RE = re.compile(r'[，,、：:；;。！？!?.\s～~…·]')


def _normalize_asr_text(text):
    """去掉标点与空白，用于临时识别与最终结果的重叠对比。"""
    return _ASR_IGNORE_RE.sub('', text or '')


def merge_asr_text(current, final):
    """把停止后到达的 final 识别结果合并进已有文本。

    临时识别与最终结果往往只差标点或个别增量，无条件拼接会造成文本
    翻倍。这里按"归一化后缀/前缀最大重叠"合并，只追加真正新增的部分。
    """
    current = (current or '').strip()
    final = (final or '').strip()
    if not final:
        return current
    if not current:
        return final
    cur_n = _normalize_asr_text(current)
    fin_n = _normalize_asr_text(final)
    if not fin_n:
        return current
    overlap = 0
    for k in range(min(len(cur_n), len(fin_n)), 0, -1):
        if cur_n.endswith(fin_n[:k]):
            overlap = k
            break
    # 把归一化重叠长度映射回 final 的原始下标，保留新增部分的原始标点
    consumed = 0
    idx = 0
    while idx < len(final) and consumed < overlap:
        consumed += len(_ASR_IGNORE_RE.sub('', final[idx]))
        idx += 1
    tail = final[idx:].strip()
    if not tail:
        return current
    if not _ASR_IGNORE_RE.sub('', tail):
        # 尾巴纯是标点（final 原样重发整句时的残留），仅补缺失的句末标点
        if current and current[-1] in '，,、：:；;。！？!?.…～':
            return current
        return current + tail
    return (current + tail).strip()


class DailyInputController(QObject):

    def __init__(self, app=None, audio_resources=None, parent=None):
        super().__init__(parent)
        self._app = app
        self._audio_resources = audio_resources
        self._listener = None
        # ASR worker 生命周期交给轮次池；本类只维护各轮次自己的文本缓冲
        self._pool = AsrRoundPool(
            worker_factory=lambda parent: AsrWorker(parent=parent),
            handlers={
                'status': self._on_status,
                'text': self._on_text_received,
                'final': self._on_final_received,
                'error': self._on_error,
                'finished': self._on_asr_finished,
            },
            parent=self,
        )
        # closing 轮次的文本缓冲：worker → {'text': 已确认文字, 'finals': set()}
        self._closing_rounds = {}
        self._recording = False
        self._last_text = ''
        self._accumulated_text = ''
        self._pending_inject_text = ''
        self._record_timeout_timer = QTimer(self)
        self._record_timeout_timer.setSingleShot(True)
        self._record_timeout_timer.timeout.connect(self._on_recording_timeout)
        self._input_bar = getattr(app, 'daily_input_bar', None)
        self._input_anchor = None

    # 兼容属性：worker 真实状态存于轮次池，这里只做读写转发
    @property
    def _asr_worker(self):
        """当前活跃 ASR worker（可能是待命的 standby）。"""
        return self._pool.active_worker

    @_asr_worker.setter
    def _asr_worker(self, worker):
        self._pool.set_active(worker)

    def _show_input_bar(self, text='', connecting=False):
        """显示独立的日常语音输入悬浮胶囊；connecting 时显示连接中动画。"""
        if self._input_bar is None:
            return
        # 先 show_listening（内部 reset 到 typing），再设置最终状态，
        # 顺序颠倒会让 reset 把 connecting 动画覆盖回 typing
        self._input_bar.show_listening(self._input_anchor)
        self._input_bar.update_text(text, connecting=connecting)

    def _update_input_bar(self, text=''):
        """更新独立语音输入悬浮胶囊中的识别文字。"""
        if self._input_bar is not None:
            self._input_bar.update_text(text)

    def _hide_input_bar(self):
        """关闭独立的日常语音输入悬浮胶囊。"""
        if self._input_bar is not None:
            self._input_bar.hide_bar()

    # ── 唤醒词互斥 ──────────────────────────────────────────────────────

    def _pause_wake_word(self):
        if self._app is not None and hasattr(self._app, '_pause_wake_word_listener'):
            self._app._pause_wake_word_listener()

    def _resume_wake_word(self):
        if self._app is not None and hasattr(self._app, '_resume_wake_word_listener'):
            self._app._resume_wake_word_listener()

    # ── 设置 ────────────────────────────────────────────────────────────

    def apply_settings(self):
        enabled = bool(config.daily_input_config.get('enabled', False))
        log.info('设置更新 enabled=%s', enabled)
        if enabled:
            self._ensure_listener()
        else:
            self._stop_listener()

    def _ensure_listener(self):
        if self._listener is not None:
            return
        hotkey = str(config.daily_input_config.get('hotkey') or 'mouse:middle')
        self._listener = HotkeyTrigger(hotkey, parent=self)
        self._listener.triggered.connect(self._on_middle_btn_toggled)
        self._listener.start()
        log.info('语音输入触发器已启动: %s', hotkey)

    def _stop_listener(self):
        if self._listener is not None:
            self._listener.stop()
            self._listener = None
            log.info('中键监听器已停止')
        self._pool.shutdown()

    # ── 中键触发 ────────────────────────────────────────────────────────

    def _on_middle_btn_toggled(self, *_):
        cursor_pos = QCursor.pos()
        self._input_anchor = (cursor_pos.x(), cursor_pos.y())
        # 若上一次 worker 已结束但没被清理，补清
        if self._asr_worker is not None and not self._asr_worker.isRunning():
            log.info('清理旧录音任务')
            self._pool.discard_active()
            self._recording = False
        if self._recording:
            self._stop_recording()
            return
        self._start_recording()

    # ── 录音生命周期 ─────────────────────────────────────────────────────

    def _start_recording(self):
        """开始一轮中键录音：无论 standby 是否已连上，都立即进入采集状态。

        worker 未建立时先占资源再创建；连接就绪与否由 AsrWorker 内部处理
        （begin_capture 先开麦缓冲，握手完成后自动补发）。
        """
        if not config.tts_config.get('api_key'):
            log.info('缺少 API Key，无法录音')
            return
        # 上一轮 worker 已结束时先丢弃，避免复用已结束的 SAUC 会话
        self._pool.discard_dead_active()
        if self._audio_resources is not None and not self._audio_resources.try_acquire('daily_input'):
            log.info('麦克风正在使用，跳过本次录音')
            return
        self._pool.start_recording(self)
        # 直连握手约 200ms，连接动画默认屏蔽（config.ASR_CONNECTING_ANIMATION 可开启）
        worker = self._pool.active_worker
        connecting = (config.ASR_CONNECTING_ANIMATION
                      and not (worker is not None and worker.is_connected()))
        log.info('开始录音' + ('（连接建立中）' if connecting else ''))
        self._show_input_bar('正在连接语音服务…' if connecting else '', connecting=connecting)
        self._pause_wake_word()
        self._recording = True
        self._last_text = ''
        self._accumulated_text = ''
        self._record_timeout_timer.start(config.ASR_RECORDING_MAX_MS)

    def _release_audio(self):
        """释放日常输入占用的主动录音资源。"""
        if self._audio_resources is not None:
            self._audio_resources.release('daily_input')

    def _stop_recording(self):
        log.info('停止录音')
        self._record_timeout_timer.stop()
        self._recording = False
        self._hide_input_bar()
        # 先保存当前已有的识别文字；停止后服务端可能还会回来最后一批 final，
        # 那部分会在 _on_asr_finished 里追加进来
        self._pending_inject_text = self._accumulated_text or self._last_text
        self._accumulated_text = ''
        worker = self._pool.active_worker
        if worker is not None:
            # 每轮独立连接：结束轮次（finish），文本缓冲归入旧轮；
            # 直连握手仅约 200ms，无需预建下一轮
            self._pool.finish_round(self)
            self._closing_rounds[worker] = {'text': self._pending_inject_text, 'finals': set()}
            # 立即清空，防止停止流程重复触发时把陈旧文本再注入一遍
            self._pending_inject_text = ''
        else:
            self._flush_pending_inject()
            self._release_audio()
        self._resume_wake_word()

    def _on_recording_timeout(self):
        if not self._recording:
            return
        text = (self._accumulated_text or self._last_text).strip()
        self._stop_recording()
        self._show_timeout_card(
            '语音输入已达到 5 分钟，已自动结束，并已输入识别内容。'
            if text else '语音输入已达到 5 分钟，已自动结束；未识别到可输入的内容。',
        )

    def _show_timeout_card(self, message, anchor=None):
        if self._app is None:
            return
        if anchor is None:
            anchor = self._app.pet.reply_card_anchor()
        self._app.note.setup_reply_card_text(
            message, anchor[0], anchor[1], 5000,
            title=config.pet_display_name(),
        )

    def _finish_recording(self, reason=''):
        log.info('录音结束 reason=%s', reason or 'callback')
        self._hide_input_bar()
        self._record_timeout_timer.stop()
        self._recording = False
        self._accumulated_text = ''
        self._pool.discard_active()
        self._release_audio()
        self._resume_wake_word()

    # ── ASR 回调 ─────────────────────────────────────────────────────────

    def _on_status(self, worker, text):
        """显示首次连接和开始识别的状态。"""
        if worker is not self._asr_worker or not self._recording:
            return
        if text == 'ASR已连接' and self._recording:
            worker.start_recording()
            # connecting 动画切回识别态并清掉连接提示文字
            if self._input_bar is not None:
                self._input_bar.update_text('')

    def _on_text_received(self, worker, text):
        # 只接受当前录音 worker 的中间结果，旧 worker 即使延迟回调也必须丢弃。
        if not self._recording or worker is not self._asr_worker:
            return
        if text and self._recording:
            self._last_text = text
            self._update_input_bar(text)

    def _on_final_received(self, worker, text):
        # 每个 worker 的结果只写入自己的轮次，不能使用控制器共享缓冲区。
        text = (text or '').strip()
        if not text:
            return
        if worker is self._asr_worker:
            merged = merge_asr_text(self._accumulated_text, text)
            if merged != self._accumulated_text:
                self._accumulated_text = merged
                self._update_input_bar(self._accumulated_text)
            return
        round_state = self._closing_rounds.get(worker)
        if round_state is None:
            log.info('忽略旧录音结果: %r', text)
            return
        merged = merge_asr_text(round_state['text'], text)
        if merged != round_state['text']:
            round_state['text'] = merged

    def _on_error(self, worker, text):
        if worker in self._closing_rounds:
            self._closing_rounds.pop(worker, None)
            self._release_audio()
            return
        if not self._pool.is_active(worker):
            return
        if not self._recording:
            # standby 空闲被服务端断开属正常现象，静默销毁，下次录音前自动重建。
            log.info('standby 连接失效，静默废弃: %s', text)
            self._pool.discard_active()
            return
        log.warning('识别错误: %s', text)
        self._update_input_bar('语音服务连接失败')
        QTimer.singleShot(1200, self._hide_input_bar)
        self._finish_recording('error')

    def _on_asr_finished(self, worker, branch):
        """旧轮收尾完成则注入其文本；当前 worker 结束则复位录音状态。"""
        if worker in self._closing_rounds:
            round_state = self._closing_rounds.pop(worker)
            self._release_audio()
            text = round_state['text']
            if text:
                QTimer.singleShot(80, lambda value=text: self._inject_text(value))
            return
        log.info('识别任务结束 branch=%s recording=%s', branch, self._recording)
        if branch == 'active':
            self._record_timeout_timer.stop()
            self._hide_input_bar()
            self._recording = False
            self._release_audio()
            # standby 空闲死亡后不自动重建，避免空闲期循环握手；下次按中键再按需建连。

    # ── 文字注入 ──────────────────────────────────────────────────────────

    def _flush_pending_inject(self):
        text = self._pending_inject_text
        self._pending_inject_text = ''
        if text:
            QTimer.singleShot(80, lambda: self._inject_text(text))

    def _inject_text(self, text):
        log.info('输入文字: %r', text)
        try:
            import time

            from pynput.keyboard import Controller, Key

            mode = config.daily_input_config.get('inject_mode') or 'paste'
            if mode == 'typing':
                # 模拟打字：与真实键入最接近，但目标窗口刚激活或中文输入法
                # 挂起时可能吞掉开头字符
                Controller().type(text)
                return
            # 复制粘贴（默认）：中文长文本零丢失，绕开输入法干扰。
            # 粘贴是异步的，稍等目标窗口读取完再把剪贴板还原成用户原有的内容
            clipboard = QApplication.clipboard()
            previous = clipboard.text()
            clipboard.setText(text)
            time.sleep(0.05)
            keyboard = Controller()
            with keyboard.pressed(Key.ctrl):
                keyboard.press('v')
                keyboard.release('v')
            if previous:
                QTimer.singleShot(600, lambda: QApplication.clipboard().setText(previous))
        except Exception as e:
            log.warning('输入失败: %s', e)

    # ── 生命周期 ──────────────────────────────────────────────────────────

    def shutdown(self):
        """应用退出：停监听器，finish 全部 worker（含 closing）并有界等待。"""
        log.info('关闭')
        self._stop_listener()
        self._record_timeout_timer.stop()
        self._hide_input_bar()
        self._recording = False
        self._release_audio()
        self._closing_rounds.clear()
        self._pool.shutdown()
