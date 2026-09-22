# coding:utf-8
"""回复卡片顶层窗口的公共交互和动画。

所有回复卡片继承此基类，获得统一的进入/移动/退出动画、拖拽定位和
右键打断能力。子类通过覆盖钩子方法（_on_double_click 等）扩展行为。
"""

import ctypes
import sys

from PySide6.QtCore import QEasingCurve, QParallelAnimationGroup, QPropertyAnimation, QPoint, Qt, QTimer, Signal
from PySide6.QtWidgets import QFrame

from clients.tts_client import stop_tts
from widgets.notifications.constants import CARD_ANIM_IN_MS, CARD_ANIM_MOVE_MS, CARD_ANIM_OUT_MS, CARD_ENTER_OFFSET, CARD_EXIT_OFFSET


class ReplyCardWindow(QFrame):
    """带拖拽、右键打断和进出动画的透明置顶回复卡片窗口。"""

    closed = Signal(str)  # 卡片真正关闭后发出，参数为 card_id
    interrupted = Signal(str)  # 用户右键双击打断时发出，参数为 card_id
    mute_tts = Signal(str)  # 静音按钮触发时发出，参数为 card_id

    def __init__(self, card_id, parent=None, fade_in=False, initial_opacity=0.0):
        """初始化无边框透明置顶窗口，fade_in 决定进入动画是否带淡入效果。"""
        super().__init__(parent)
        self.card_id = card_id
        self.fade_in = fade_in
        self.anim_group = None
        self.closing = False
        self.closed_emitted = False
        self.dragging = False
        self.drag_moved = False
        self.drag_start_pos = QPoint()
        self.drag_window_pos = QPoint()
        self.manual_position = False
        self._last_left_click_time = 0.0
        self._last_right_click_time = 0.0
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool | Qt.NoDropShadowWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setWindowOpacity(initial_opacity)

    def _ensure_topmost(self):
        """通过 raise_ + Win32 SetWindowPos 双保险强制窗口置顶。"""
        try:
            self.raise_()
        except RuntimeError:
            return
        if sys.platform != 'win32':
            return
        try:
            hwnd = int(self.winId())
            # 用 Win32 API 强制置顶，防止其他全屏应用或任务栏遮住卡片
            # Qt.WindowStaysOnTopHint 在某些场景下会被系统忽略，所以这里做双保险
            flags = 0x0001 | 0x0002 | 0x0010 | 0x0040  # NOMOVE | NOSIZE | NOACTIVATE | SHOWWINDOW
            ctypes.windll.user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, flags)
        except Exception:
            pass

    def _refresh_topmost_soon(self):
        # showEvent 后系统可能短暂将窗口置后，用多个延时回调反复置顶直到稳定
        self._ensure_topmost()
        for delay in (0, 60, 180, 360):
            QTimer.singleShot(delay, self._ensure_topmost)

    def showEvent(self, event):
        """窗口显示后立即触发多轮置顶补偿。"""
        super().showEvent(event)
        self._refresh_topmost_soon()

    def animate_in(self, end_pos):
        """入场动画：从 end_pos + CARD_ENTER_OFFSET 偏移处滑入到目标位置。"""
        if self.anim_group is not None:
            self.anim_group.stop()
        self.move(end_pos + CARD_ENTER_OFFSET)
        self.show()
        self._refresh_topmost_soon()
        pos_anim = QPropertyAnimation(self, b'pos', self)
        pos_anim.setDuration(CARD_ANIM_IN_MS)
        pos_anim.setStartValue(self.pos())
        pos_anim.setEndValue(end_pos)
        pos_anim.setEasingCurve(QEasingCurve.OutCubic)
        self.anim_group = QParallelAnimationGroup(self)
        self.anim_group.addAnimation(pos_anim)
        if self.fade_in:
            opacity_anim = QPropertyAnimation(self, b'windowOpacity', self)
            opacity_anim.setDuration(CARD_ANIM_IN_MS)
            opacity_anim.setStartValue(0.0)
            opacity_anim.setEndValue(1.0)
            self.anim_group.addAnimation(opacity_anim)
        else:
            self.setWindowOpacity(1.0)
        self.anim_group.finished.connect(self._refresh_topmost_soon)
        self.anim_group.start()

    def animate_to(self, end_pos):
        """平滑移动到新位置，用于 reflow 时卡片堆叠重排。"""
        if self.closing:
            return
        if self.anim_group is not None:
            self.anim_group.stop()
        pos_anim = QPropertyAnimation(self, b'pos', self)
        pos_anim.setDuration(CARD_ANIM_MOVE_MS)
        pos_anim.setStartValue(self.pos())
        pos_anim.setEndValue(end_pos)
        pos_anim.setEasingCurve(QEasingCurve.OutCubic)
        self.anim_group = QParallelAnimationGroup(self)
        self.anim_group.addAnimation(pos_anim)
        self.anim_group.finished.connect(self._refresh_topmost_soon)
        self.anim_group.start()

    def request_close(self):
        """请求关闭：置 closing 标记防重入，先跑退出动画再真正关闭。"""
        if self.closing:
            return
        self.closing = True
        self._before_request_close()
        self._animate_out()

    def mousePressEvent(self, event):
        """处理三种鼠标交互：右键双击打断、左键双击钩子、左键拖拽。"""
        if event.button() == Qt.RightButton:
            now = __import__('time').time()
            if now - getattr(self, '_last_right_click_time', 0) < 0.4:
                self._interrupt()
                self._last_right_click_time = 0
            else:
                self._last_right_click_time = now
            event.accept()
            return
        if event.button() == Qt.LeftButton:
            now = __import__('time').time()
            if not self.dragging and (now - self._last_left_click_time) < 0.35:
                self._last_left_click_time = 0.0
                self._on_double_click()
                event.accept()
                return
            self._last_left_click_time = now
            self.dragging = True
            self.drag_moved = False
            self.drag_start_pos = event.globalPos()
            self.drag_window_pos = self.pos()
            if self.anim_group is not None:
                self.anim_group.stop()
            self._ensure_topmost()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        """拖拽中跟随鼠标移动窗口；位移超过 4px 记为有效拖动。"""
        if self.dragging and event.buttons() & Qt.LeftButton:
            if (event.globalPos() - self.drag_start_pos).manhattanLength() >= 4:
                self.drag_moved = True
            self.move(self.drag_window_pos + event.globalPos() - self.drag_start_pos)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        """结束拖拽；发生过有效拖动则标记手动定位，退出自动重排。"""
        if event.button() == Qt.LeftButton and self.dragging:
            self.dragging = False
            if self.drag_moved:
                # 用户手动拖拽过，标记 manual_position，后续 reflow 不再自动移动此卡片
                self.manual_position = True
                self._on_manual_positioned()
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def _mute_tts(self):
        """停止 TTS 播放并广播 mute_tts 信号。"""
        stop_tts()
        self.mute_tts.emit(self.card_id)

    def _interrupt(self):
        """右键双击关闭卡片，并通知上层停止当前回复。"""
        stop_tts()
        self.request_close()
        self.interrupted.emit(self.card_id)

    def _before_request_close(self):
        """关闭前钩子：停止子类可能注册的自动关闭定时器。"""
        timer = getattr(self, 'timer', None)
        if timer is not None:
            timer.stop()

    def _before_close_event(self):
        pass

    def _on_manual_positioned(self):
        pass

    def _on_double_click(self):
        pass

    def _animate_out(self):
        # 退出动画：向下滑出（CARD_EXIT_OFFSET）同时隐去，动画结束后才真正 close
        # 这样用户能看到卡片"飞走"而非瞬间消失
        if self.anim_group is not None:
            self.anim_group.stop()
        pos_anim = QPropertyAnimation(self, b'pos', self)
        pos_anim.setDuration(CARD_ANIM_OUT_MS)
        pos_anim.setStartValue(self.pos())
        pos_anim.setEndValue(self.pos() + CARD_EXIT_OFFSET)
        pos_anim.setEasingCurve(QEasingCurve.InCubic)
        self.anim_group = QParallelAnimationGroup(self)
        self.anim_group.addAnimation(pos_anim)
        self.anim_group.finished.connect(self.close)
        self.anim_group.start()

    def closeEvent(self, event):
        """真正关闭：调子类清理钩子并保证 closed 信号只发一次。"""
        self._before_close_event()
        if not self.closed_emitted:
            self.closed_emitted = True
            self.closed.emit(self.card_id)
        super().closeEvent(event)
