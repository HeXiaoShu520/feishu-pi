# coding:utf-8
"""Streaming reply TTS queue with audio prefetch and ordered playback.

核心设计：双线程流水线。
  - _synth_loop（后台线程）：将文本块逐个送往 TTS API 合成 PCM，结果放入 audio_queue。
  - run（QThread）：按顺序从 audio_queue 取出 PCM 并即时播放，保证播放顺序不乱。
两个队列解耦合成和播放，合成慢时播放端等待，合成快时提前缓冲，减少用户感知延迟。
"""

import queue
import re
import threading

from PySide6.QtCore import QObject, QThread, Signal

import config
from clients.tts_client import (
    PcmStreamPlayer,
    SAMPLE_RATE,
    clear_active_player,
    request_audio_chunks,
    set_active_player,
    stop_tts,
)


STREAM_TTS_FIRST_MIN_CHARS = 15
STREAM_TTS_FIRST_TARGET_CHARS = 30
STREAM_TTS_FIRST_MAX_CHARS = 38
STREAM_TTS_NEXT_MIN_CHARS = 50
STREAM_TTS_NEXT_TARGET_CHARS = 80
STREAM_TTS_NEXT_MAX_CHARS = 100
# 默认关闭高频 TTS 调试输出，避免运行日志被合成过程淹没。
STREAM_TTS_DEBUG = False


def _debug(message):
    """受 STREAM_TTS_DEBUG 开关控制的调试日志输出。"""
    if STREAM_TTS_DEBUG:
        print(message, flush=True)


def _tts_countable_text(text):
    """去掉空白和标点后的文本，用于按有效字符数计算切分阈值。"""
    return re.sub(r"""[\s\n\r\t。！？!?；;，,、：:.…~`*_#\[\](){}<>"'\-]+""", '', text or '')


def _last_mark_index(text, marks, end):
    """在 text[0:end] 内找指定标点集合最后出现的位置，返回切点（其后一位）。"""
    positions = [text.rfind(mark, 0, end) for mark in marks]
    return max(positions) + 1


def stream_tts_cut_index(text, terminal=False, first_chunk=True):
    """Return a stable cut point for text that can be sent to TTS.

    首块用较小阈值（15~38字）以降低首字延迟；后续块用更大阈值（50~100字）
    减少 TTS 请求次数。优先在句末（。！？）切断，其次软标点（，、:），
    最后退化为强截断到 max_chars。
    """
    text = text or ''
    if not text:
        return 0
    min_chars = STREAM_TTS_FIRST_MIN_CHARS if first_chunk else STREAM_TTS_NEXT_MIN_CHARS
    target_chars = STREAM_TTS_FIRST_TARGET_CHARS if first_chunk else STREAM_TTS_NEXT_TARGET_CHARS
    max_chars = STREAM_TTS_FIRST_MAX_CHARS if first_chunk else STREAM_TTS_NEXT_MAX_CHARS
    if terminal and len(text) <= max_chars:
        return len(text)
    if len(_tts_countable_text(text)) < min_chars:
        return len(text) if terminal else 0

    hard_cut = _last_mark_index(text, '\n。！？!?；;', min(len(text), max_chars) + 1)
    if hard_cut > 0 and len(_tts_countable_text(text[:hard_cut])) >= min_chars:
        return hard_cut

    if not terminal and len(text) < target_chars:
        return 0

    soft_cut = _last_mark_index(text, '，,、：: ', min(len(text), max_chars) + 1)
    if soft_cut > 0 and len(_tts_countable_text(text[:soft_cut])) >= min_chars:
        return soft_cut

    return min(len(text), max_chars)


class _PipelineTtsWorker(QThread):
    """Prefetch TTS audio in one thread while another ordered loop plays it."""

    chunk_started = Signal(str, str)
    result_ready = Signal(bool, str)
    _STOP = object()

    def __init__(self, label='TTS', parent=None):
        super().__init__(parent)
        self.label = label
        self.text_queue = queue.Queue()
        self.audio_queue = queue.Queue()
        self.stop_event = threading.Event()
        self.pause_event = threading.Event()
        self.resume_event = threading.Event()
        self.resume_event.set()
        self.player = None

    def enqueue(self, stream_id, text, terminal=False):
        """把一段待合成文本放入文本队列；terminal 表示这是流最后一块。"""
        _debug('[StreamTTS] queued chars=%d terminal=%s stream=%s' % (len(text or ''), terminal, stream_id))
        self.text_queue.put((stream_id, text, bool(terminal)))

    def finish_stream(self, stream_id):
        """投递空 terminal 块，通知合成循环该流已结束。"""
        self.text_queue.put((stream_id, '', True))

    def stop(self):
        """停止流水线：置停止标志、投递哨兵唤醒阻塞线程并关闭播放器。"""
        # 先设置 stop_event，再往两个队列各塞一个哨兵，确保阻塞在 get() 的线程能及时退出
        self.stop_event.set()
        self.text_queue.put(self._STOP)
        self.audio_queue.put(self._STOP)
        stop_tts()
        player = self.player
        if player is not None:
            try:
                player.close()
            except Exception:
                pass

    def pause(self):
        """暂停合成与播放（同时暂停已创建的播放器）。"""
        self.pause_event.set()
        self.resume_event.clear()
        if self.player is not None:
            self.player.pause()

    def resume(self):
        """恢复合成与播放。"""
        self.pause_event.clear()
        self.resume_event.set()
        if self.player is not None:
            self.player.resume()

    def _wait_if_paused(self):
        """暂停期间自旋等待，每 0.1 秒检查一次停止标志避免卡死。"""
        while self.pause_event.is_set() and not self.stop_event.is_set():
            self.resume_event.wait(0.1)

    def run(self):
        """播放循环：启动合成线程后按顺序消费音频队列并写入播放器。"""
        cfg = dict(config.tts_config)
        synth = threading.Thread(target=self._synth_loop, args=(cfg,), daemon=True)
        synth.start()
        try:
            has_audio = False
            while not self.stop_event.is_set():
                item = self.audio_queue.get()
                if item is self._STOP:
                    break
                kind = item[0]
                if kind == 'error':
                    raise RuntimeError(item[1])
                if kind == 'done':
                    break
                _kind, stream_id, text, chunks = item
                if not chunks:
                    continue
                if self.player is None:
                    self.player = PcmStreamPlayer(SAMPLE_RATE)
                    set_active_player(self.player)
                    _debug('[StreamTTS] playback started stream=%s' % stream_id)
                self.chunk_started.emit(stream_id, text)
                for payload in chunks:
                    self._wait_if_paused()
                    if self.stop_event.is_set():
                        break
                    if payload:
                        has_audio = True
                        self.player.write(payload)
            if not self.stop_event.is_set() and has_audio:
                self._wait_if_paused()
                self.player.wait_done()
            if not self.stop_event.is_set():
                self.result_ready.emit(True, '')
        except Exception as exc:
            if not self.stop_event.is_set():
                self.result_ready.emit(False, str(exc))
        finally:
            self.stop_event.set()
            self.text_queue.put(self._STOP)
            synth.join(timeout=0.2)
            player = self.player
            self.player = None
            if player is not None:
                clear_active_player(player)
                try:
                    player.close()
                except Exception:
                    pass

    def _synth_loop(self, cfg):
        """合成线程：逐块调用 TTS API 合成 PCM，结果按序放入音频队列。"""
        while not self.stop_event.is_set():
            self._wait_if_paused()
            if self.stop_event.is_set():
                return
            item = self.text_queue.get()
            if item is self._STOP:
                self.audio_queue.put(self._STOP)
                return
            stream_id, text, terminal = item
            try:
                if text:
                    _debug('[StreamTTS] synth start chars=%d stream=%s' % (len(text or ''), stream_id))
                    chunks = request_audio_chunks(text, cfg, cancel_event=self.stop_event)
                    _debug('[StreamTTS] synth done chunks=%d stream=%s' % (len(chunks or []), stream_id))
                    if not self.stop_event.is_set():
                        self.audio_queue.put(('audio', stream_id, text, chunks))
                if terminal and not self.stop_event.is_set():
                    self.audio_queue.put(('done', stream_id))
                    return
            except Exception as exc:
                if not self.stop_event.is_set():
                    self.audio_queue.put(('error', str(exc)))
                return


class StreamTtsQueue(QObject):
    """Cut streaming text, prefetch TTS audio, then play chunks in order."""

    def __init__(self, parent=None, label='TTS', on_started=None, on_idle=None):
        super().__init__(parent)
        self.label = label
        self.on_started = on_started
        self.on_idle = on_idle
        self.worker = None
        self.current_stream_id = None
        self.consumed = {}
        self.chunk_counts = {}
        self.final_streams = set()
        self.last_texts = {}
        self.paused = False
        self.stopping_workers = []

    def is_active(self):
        """当前是否有正在运行的 TTS worker。"""
        return self.worker is not None

    def queue_text(self, stream_id, text, terminal=False):
        """接收流式文本增量，按切分点拆块后交给 worker 合成播放。"""
        # consumed 记录已交给 worker 的字符数，避免流式追加时重复发送已处理的前缀
        stream_id = stream_id or '__default__'
        text = (text or '').replace('\\n', '\n').replace('\\r', '\r').replace('\\t', '\t').strip()
        # 本轮朗读字数上限（设置页"单次朗读的最大文本长度"）：只合成前 N 字，
        # 卡片仍显示完整回复；不截断的话分块合成的每块都不到上限，长文会全部播报
        limit = max(1, int(config.tts_config.get('max_chars') or 200))
        if len(text) > limit:
            text = text[:limit]
        previous_text = self.last_texts.get(stream_id, '')
        if text == previous_text and (not terminal or stream_id in self.final_streams):
            return False
        if text:
            self.last_texts[stream_id] = text
        if terminal:
            self.final_streams.add(stream_id)
        if not text:
            self._finish_if_needed(stream_id, terminal)
            return False
        if not self._enabled():
            self._maybe_emit_idle()
            return False

        consumed = int(self.consumed.get(stream_id, 0) or 0)
        if consumed > len(text):
            consumed = 0
        delta = text[consumed:]
        if not delta.strip():
            self._finish_if_needed(stream_id, terminal)
            return False

        queued = False
        while delta.strip():
            chunk_count = int(self.chunk_counts.get(stream_id, 0) or 0)
            cut = stream_tts_cut_index(delta, terminal=terminal, first_chunk=(chunk_count == 0))
            if cut <= 0:
                break

            chunk = delta[:cut]
            consumed += cut
            self.consumed[stream_id] = consumed
            if not chunk.strip():
                break

            self._ensure_worker(stream_id)
            is_terminal_chunk = terminal and consumed >= len(text)
            self.worker.enqueue(stream_id, chunk, terminal=is_terminal_chunk)
            self.chunk_counts[stream_id] = chunk_count + 1
            queued = True
            if not terminal:
                break
            delta = text[consumed:]

        if terminal and not delta.strip() and not queued:
            self._finish_if_needed(stream_id, terminal)
        return queued

    def reset(self, stream_id=None, stop_current=True):
        """清空指定流（或全部流）的切分进度状态，可同时停止当前 worker。"""
        if stream_id is None:
            self.consumed.clear()
            self.chunk_counts.clear()
            self.final_streams.clear()
            self.last_texts.clear()
            self.paused = False
            if stop_current:
                self._stop_current()
            return
        self.consumed.pop(stream_id, None)
        self.chunk_counts.pop(stream_id, None)
        self.final_streams.discard(stream_id)
        self.last_texts.pop(stream_id, None)
        if stop_current and self.current_stream_id == stream_id:
            self._stop_current()

    def _enabled(self):
        """TTS 功能开关：配置启用且已填 API Key 才生效。"""
        cfg = config.tts_config
        return bool(cfg.get('enabled') and cfg.get('api_key'))

    def _ensure_worker(self, stream_id):
        """确保有 worker 服务当前流；换流时先停掉旧 worker 再新建。"""
        if self.worker is not None and self.current_stream_id != stream_id:
            self._stop_current()
        if self.worker is not None:
            return
        self.current_stream_id = stream_id
        self.worker = _PipelineTtsWorker(self.label, parent=self)
        self.worker.chunk_started.connect(self._on_chunk_started)
        self.worker.result_ready.connect(self._on_done)
        self.worker.start()
        if self.paused:
            self.worker.pause()

    def pause(self):
        """暂停当前 TTS 流水线。"""
        self.paused = True
        if self.worker is not None:
            self.worker.pause()
        return True

    def resume(self):
        """恢复 TTS 流水线；未处于暂停状态时返回 False。"""
        if not self.paused:
            return False
        self.paused = False
        if self.worker is not None:
            self.worker.resume()
        return True

    def is_paused(self):
        """查询当前是否处于暂停状态。"""
        return self.paused

    def _finish_if_needed(self, stream_id, terminal):
        """terminal 流结束时通知 worker 收尾，否则尝试上报空闲。"""
        if terminal and self.worker is not None and self.current_stream_id == stream_id:
            self.worker.finish_stream(stream_id)
            return
        self._maybe_emit_idle()

    def _on_chunk_started(self, stream_id, text):
        """worker 开始播放一块音频时转发给 on_started 回调。"""
        if self.on_started:
            self.on_started(stream_id, text)

    def _on_done(self, success, text):
        """worker 结束回调：清理状态并在失败时打印错误，触发 on_idle。"""
        if not success:
            print('%s failed: %s' % (self.label, text))
        self.worker = None
        self.current_stream_id = None
        self.final_streams.clear()
        if self.on_idle:
            self.on_idle()

    def _stop_current(self):
        # 断开信号连接后再 stop()，防止 worker 退出时触发 _on_done 干扰新流的状态
        worker = self.worker
        self.worker = None
        self.current_stream_id = None
        if worker is None:
            return
        try:
            worker.chunk_started.disconnect(self._on_chunk_started)
            worker.result_ready.disconnect(self._on_done)
        except (TypeError, RuntimeError):
            pass
        worker.stop()
        worker.wait(300)
        if worker.isRunning():
            self.stopping_workers.append(worker)
            worker.finished.connect(lambda w=worker: self._forget_stopping_worker(w))

    def _forget_stopping_worker(self, worker):
        """worker 真正退出后从待回收列表移除，防止引用泄漏。"""
        if worker in self.stopping_workers:
            self.stopping_workers.remove(worker)

    def _maybe_emit_idle(self):
        """所有流都已结束且无 worker 时清空标记并触发 on_idle 回调。"""
        if self.worker is not None or not self.final_streams:
            return
        self.final_streams.clear()
        if self.on_idle:
            self.on_idle()
