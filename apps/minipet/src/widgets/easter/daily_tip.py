# coding:utf-8
import random

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QFont, QPainter

from widgets.easter.base import EasterGamePopup


class DailyTipPopup(EasterGamePopup):
    title = '每日小技巧'
    TIPS = [
        ('Git', 'git commit --fixup 可以配合 rebase --autosquash 自动整理提交。'),
        ('Python', 'pathlib.Path 比 os.path 更适合写现代路径处理代码。'),
        ('PySide', '频繁动画用 QTimer 控制 repaint，比反复创建动画对象更稳。'),
        ('Debug', '先写一个最小复现，再猜原因，速度通常更快。'),
        ('VS Code', 'Ctrl+Shift+L 可以同时选中所有匹配项批量编辑。'),
        ('正则', '非贪婪匹配用 *? 或 +?，适合截取最近的闭合片段。'),
        ('架构', '先让数据流清楚，再考虑抽象；抽象太早容易变成负担。'),
    ]

    def __init__(self, x, y, parent=None):
        self.kind, self.tip = random.choice(self.TIPS)
        super().__init__(x, y, parent)

    def paintEvent(self, event):
        painter = QPainter(self)
        self._draw_card(painter, QColor(248, 255, 246, 248), QColor(178, 222, 169, 230))
        elapsed = self._elapsed()
        p = self._ease_out(min(1, elapsed / 0.7))
        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor(96, 181, 122, 220))
        painter.drawRoundedRect(68, int(76 - 12 * (1 - p)), 144, 34, 17, 17)
        painter.setFont(QFont('Microsoft YaHei UI', 12, QFont.Bold))
        painter.setPen(QColor(255, 255, 255))
        painter.drawText(68, int(82 - 12 * (1 - p)), 144, 24, Qt.AlignCenter, self.kind)
        painter.setFont(QFont('Microsoft YaHei UI', 10))
        painter.setPen(QColor(48, 82, 56))
        painter.drawText(34, 130, self.width() - 68, 82, Qt.AlignCenter | Qt.TextWordWrap, self.tip)
