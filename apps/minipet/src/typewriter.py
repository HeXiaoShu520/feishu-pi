# coding:utf-8
from PySide6.QtCore import QTimer
import shiboken6

from log_util import get_logger

log = get_logger('voice.typewriter')



def _cfg():
    import config
    return config.typewriter_config


class Typewriter:
    """逐字打印到任意 QLabel 或 QTextBrowser。
    set_text(full_text) — 立即替换（跳过打字）
    typewrite(text) — 打字机效果（受 config 控制）
    append_chunk(chunk) — 流式追加新 token
    """

    def __init__(self, widget, speed_ms=None, max_duration_ms=None,
                 enabled=None, on_update=None):
        self._w = widget
        self._speed_override = speed_ms  # 若传入则覆盖 config
        self._max_duration_override = max_duration_ms
        self._enabled_override = enabled
        self._on_update = on_update
        self._target = ''   # 最终要显示的完整文本
        self._shown = 0     # 当前已显示的字符数，用于逐字推进
        self._timer = QTimer()
        self._timer.timeout.connect(self._tick)

    def _speed(self):
        if self._speed_override is not None:
            return self._speed_override
        return int(_cfg().get('speed_ms', 28))

    def _max_duration(self):
        if self._max_duration_override is not None:
            return int(self._max_duration_override)
        return int(_cfg().get('max_duration_ms', 5000))

    def _enabled(self):
        if self._enabled_override is not None:
            return bool(self._enabled_override)
        return bool(_cfg().get('enabled', True))

    def _is_label(self):
        from PySide6.QtWidgets import QTextEdit
        return not isinstance(self._w, QTextEdit)

    def _set(self, text):
        if self._w is None or not shiboken6.isValid(self._w):
            self._timer.stop()
            return
        if self._is_label():
            self._w.setText(text)
        else:
            self._w.setHtml('<p style="margin:0">%s</p>' % text.replace('\n', '<br>'))
        if self._on_update is not None:
            self._on_update()

    def _calc_interval(self):
        # 动态调速：剩余字符越多，间隔越短，确保整段文字在 max_duration 内
        # 打完（下限 8ms）。跨标签的渲染抖动由 _clean_cut 修复，不靠拖慢速度。
        remaining = len(self._target) - self._shown
        if remaining <= 0:
            return self._speed()
        ideal = self._max_duration() // max(remaining, 1)
        return max(8, min(self._speed(), ideal))

    def _tick(self):
        if self._shown >= len(self._target):
            self._timer.stop()
            return
        self._shown += 1
        self._clean_cut()
        self._set(self._target[:self._shown])
        self._timer.setInterval(self._calc_interval())

    def _clean_cut(self):
        """若当前切点落在 HTML 标签内部，前进到标签结束后。

        标签被拆半渲染的瞬间（如 <br> 只打了一半）该行会短暂消失，
        高度随之抖动；整体跳过标签保证每次渲染的标签都是完整的。
        """
        target = self._target
        if not target or self._shown >= len(target):
            return
        seg = target[:self._shown]
        lt = seg.rfind('<')
        if lt == -1 or '>' in seg[lt:]:
            return
        close = target.find('>', self._shown - 1)
        self._shown = (close + 1) if close != -1 else len(target)

    def typewrite(self, text):
        log.info('Typewriter.typewrite: %d 字开始打字 @%dms/字', len(text or ''), self._speed())
        self._timer.stop()
        self._target = text
        self._shown = 0
        if not self._enabled():
            self._set(text)
            self._shown = len(text)
            return
        self._timer.start(self._calc_interval())

    def append_chunk(self, chunk):
        # 流式场景：新 token 到来时只追加到 _target，定时器自然推进显示
        # 不重置 _shown，避免已打出的内容闪烁重播
        self._target += chunk
        if not self._enabled():
            self._set(self._target)
            self._shown = len(self._target)
            return
        if not self._timer.isActive():
            self._timer.start(self._calc_interval())

    def set_text(self, text):
        if text:
            log.info('Typewriter.set_text: %d 字瞬间渲染', len(text))
        self._timer.stop()
        self._target = text
        self._shown = len(text)
        self._set(text)

    def continue_from(self, text, shown=0):
        """以 text 为新目标继续打字，前 shown 个字符视为已显示。

        用于流式正文尾部被 markdown 重写的场景：不瞬间渲染，也不从零
        重播，而是沿着新目标从重叠处继续逐字推进。
        """
        self._timer.stop()
        self._target = text
        self._shown = max(0, min(int(shown), len(text)))
        self._clean_cut()
        if not self._enabled():
            self._set(text)
            self._shown = len(text)
            return
        self._timer.start(self._calc_interval())
