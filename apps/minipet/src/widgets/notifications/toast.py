# coding:utf-8
"""右下角系统 Toast。
非交互式的轻量通知弹窗：显示标题、正文与可选图标，超时或点击关闭后
通过 closed 信号向管理方上报，便于堆叠布局回收。"""

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import QApplication, QFrame, QHBoxLayout, QLabel, QVBoxLayout, QWidget
from qfluentwidgets import CaptionLabel, StrongBodyLabel, TransparentToolButton
from qfluentwidgets import FluentIcon as FIF

import config

class Toast(QWidget):
    """右下角普通系统提示窗口。"""

    closed = Signal(str)

    def __init__(self, note_id, title, message, icon=None, timeout=5000, parent=None):
        """构建无边框半透明 Toast：图标 + 文本区 + 关闭按钮，并启动超时定时器。"""
        super().__init__(parent)
        self.note_id = note_id
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool | Qt.NoDropShadowWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        frame = QFrame()
        frame.setStyleSheet('''
            QFrame { border: 1px solid #202020; border-radius: 6px; background: white; }
            QLabel { border: 0; background: transparent; color: black; }
        ''')
        layout = QHBoxLayout(frame)
        layout.setContentsMargins(10, 8, 10, 8)
        if icon and not icon.isNull():
            icon_label = QLabel()
            screen = QApplication.primaryScreen()
            dpr = screen.devicePixelRatio() if screen else 1.0  # 按屏幕 DPI 缩放图标，避免高分屏发虚
            pm = icon.scaled(int(28 * dpr), int(28 * dpr), Qt.KeepAspectRatio, Qt.SmoothTransformation)
            pm.setDevicePixelRatio(dpr)
            icon_label.setPixmap(pm)
            layout.addWidget(icon_label)
        text_box = QVBoxLayout()
        title_label = StrongBodyLabel(title or config.APP_DISPLAY_NAME)
        msg_label = CaptionLabel(message or '')
        msg_label.setWordWrap(True)
        msg_label.setMaximumWidth(260)
        text_box.addWidget(title_label)
        text_box.addWidget(msg_label)
        layout.addLayout(text_box, 1)
        close_btn = TransparentToolButton(FIF.CLOSE)
        close_btn.clicked.connect(self.close)
        layout.addWidget(close_btn)
        outer = QHBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(frame)
        self.timer = QTimer(self)
        self.timer.setSingleShot(True)
        self.timer.timeout.connect(self.close)
        self.timer.start(timeout)
        self.adjustSize()

    def show_at(self, offset):
        """按 offset（下方已有其他 Toast 的高度）在屏幕右下角错开显示。"""
        screen = QApplication.primaryScreen().availableGeometry()
        self.move(screen.right() - self.width() - 24, screen.bottom() - self.height() - 24 - offset)
        self.show()

    def closeEvent(self, event):
        """关闭时上报 note_id，让管理方收拢剩余 Toast 的堆叠位置。"""
        self.closed.emit(self.note_id)
        super().closeEvent(event)


