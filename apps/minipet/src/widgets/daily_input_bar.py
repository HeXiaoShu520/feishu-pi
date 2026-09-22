# coding:utf-8
"""日常工作语音输入悬浮胶囊。"""

from PySide6.QtCore import QPoint, QTimer, Qt
from PySide6.QtWidgets import QApplication, QWidget

from widgets.pet_voice_popup import VoiceOrbWidget


class DailyInputBar(QWidget):
    """复用语音球视觉组件、但独立显示位置和生命周期的语音输入胶囊。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._anchor = None
        self.setWindowFlags(
            Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint |
            Qt.Tool | Qt.WindowDoesNotAcceptFocus | Qt.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WA_ShowWithoutActivating, True)

        self.orb = VoiceOrbWidget(self)
        self.orb.set_initial_content('typing', '')
        self.orb.width_changed.connect(self._sync_geometry)
        self._anim_timer = QTimer(self)
        self._anim_timer.timeout.connect(self._tick)
        self._sync_geometry()

    def _tick(self):
        """推进与语音球一致的动画。"""
        self.orb.set_phase((self.orb.phase + 1) % 24)
        self.orb._tick_ripples()
        self.orb.update()

    def _sync_geometry(self):
        """根据语音球宽度调整独立窗口，并保持在点击点上方。"""
        height = 64 if self.orb.multiline else 40
        self.setFixedSize(self.orb.width(), height)
        self.orb.setFixedHeight(height)
        self._reposition()

    def _reposition(self):
        """把胶囊定位到点击位置上方，并限制在屏幕范围内。"""
        screen_point = QPoint(*self._anchor) if self._anchor is not None else QApplication.primaryScreen().availableGeometry().center()
        screen = QApplication.screenAt(screen_point) or QApplication.primaryScreen()
        if screen is None:
            return
        geo = screen.availableGeometry()
        if self._anchor is None:
            x = geo.left() + (geo.width() - self.width()) // 2
            y = geo.bottom() - self.height() - 48
        else:
            anchor_x, anchor_y = self._anchor
            x = int(anchor_x - self.width() / 2)
            y = int(anchor_y - self.height() - 18)
            x = max(geo.left() + 4, min(x, geo.right() - self.width() - 4))
            y = max(geo.top() + 4, y)
        self.move(x, y)

    def reset(self):
        """重置文字和宽度。"""
        self.orb.set_initial_content('typing', '')
        self._sync_geometry()

    def setText(self, text):
        """设置识别文字。"""
        self.update_text(text)

    def update_text(self, text, connecting=False):
        """更新识别文字并复用语音球的宽度动画；connecting 态显示握手中的旋转弧线。"""
        self.orb.set_state('connecting' if connecting else 'typing')
        self.orb.set_text(text)
        self._sync_geometry()

    def show_listening(self, anchor=None):
        """在指定点击坐标上方显示独立语音输入胶囊。"""
        self._anchor = anchor
        self.reset()
        self.show()
        self.raise_()
        self._anim_timer.start(120)
        self._reposition()

    def hide_bar(self):
        """隐藏语音输入胶囊并停止动画。"""
        self._anim_timer.stop()
        self.hide()
