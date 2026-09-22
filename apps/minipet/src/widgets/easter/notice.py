# coding:utf-8

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QFont, QPainter

from widgets.easter.base import EasterGamePopup


class GameNoticePopup(EasterGamePopup):
    def __init__(self, x, y, title, text, parent=None):
        self.title = title
        self.text = text
        super().__init__(x, y, parent)

    def paintEvent(self, event):
        painter = QPainter(self)
        self._draw_card(painter)
        painter.setFont(QFont('Microsoft YaHei UI', 11, QFont.Bold))
        painter.setPen(QColor(92, 59, 24))
        painter.drawText(34, 96, self.width() - 68, 100, Qt.AlignCenter | Qt.TextWordWrap, self.text)
