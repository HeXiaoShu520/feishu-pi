# coding:utf-8
"""Delay streamed UI updates by a fixed offset while preserving order.

TTS 播放存在固定延迟；若文字与语音同步推进，视觉上会超前于音频。
此模块通过把 UI 更新回调推迟 tts_delay_ms 毫秒来对齐两者节奏。
每个"lane"对应一路独立的回复流，互不干扰。
"""

import math
import time

from PySide6.QtCore import QObject, QTimer

try:
    import config
except ModuleNotFoundError:
    from src import config


class StreamDisplayDelay(QObject):
    """Schedule UI callbacks independently for each streamed reply lane."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._lanes = {}        # lane_id -> [(due_at, callback), ...]
        self._timers = {}       # lane_id -> 当前活跃的 QTimer
        self._generations = {}  # lane_id -> 重置计数，用于丢弃过期回调
        self._latest_versions = {}  # lane_id -> 最新文本版本，防止旧快照回退 UI

    def enqueue(self, lane_id, callback, version=None):
        lane_id = str(lane_id or '__default__')
        if version is not None:
            version = int(version)
            if version <= self._latest_versions.get(lane_id, 0):
                return
            self._latest_versions[lane_id] = version
        delay_ms = self._delay_ms()
        if delay_ms <= 0:
            callback()
            return
        due_at = time.monotonic() + delay_ms / 1000.0
        self._lanes.setdefault(lane_id, []).append((due_at, callback, version))
        self._schedule(lane_id)

    def reset(self, lane_id=None):
        # 新一轮回复开始时调用，丢弃上一轮残留的所有回调和定时器
        if lane_id is None:
            lane_ids = set(self._lanes) | set(self._timers) | set(self._generations)
        else:
            lane_ids = {str(lane_id or '__default__')}
        for current_lane in lane_ids:
            self._generations[current_lane] = self._generations.get(current_lane, 0) + 1
            self._lanes.pop(current_lane, None)
            self._latest_versions.pop(current_lane, None)
            timer = self._timers.pop(current_lane, None)
            if timer is not None:
                timer.stop()
                timer.deleteLater()

    @staticmethod
    def _delay_ms():
        # 仅在 TTS 已配置且启用时才引入延迟；纯文字模式下延迟无意义
        if not (config.tts_config.get('enabled') and config.tts_config.get('api_key')):
            return 0
        return max(0, int(config.typewriter_config.get('tts_delay_ms') or 0))

    def _schedule(self, lane_id):
        if lane_id in self._timers:
            return
        items = self._lanes.get(lane_id)
        if not items:
            return
        generation = self._generations.get(lane_id, 0)
        wait_ms = max(0, math.ceil((items[0][0] - time.monotonic()) * 1000))
        timer = QTimer(self)
        timer.setSingleShot(True)
        timer.timeout.connect(lambda lane=lane_id, token=generation: self._run_next(lane, token))
        self._timers[lane_id] = timer
        timer.start(wait_ms)

    def _run_next(self, lane_id, generation):
        timer = self._timers.pop(lane_id, None)
        if timer is not None:
            timer.deleteLater()
        # generation 不匹配说明已被 reset()，回调已过期，直接丢弃
        if generation != self._generations.get(lane_id, 0):
            return
        items = self._lanes.get(lane_id)
        if not items:
            return
        _due_at, callback, version = items.pop(0)
        if not items:
            self._lanes.pop(lane_id, None)
        if version is None or version == self._latest_versions.get(lane_id, 0):
            callback()
        if generation == self._generations.get(lane_id, 0):
            self._schedule(lane_id)
