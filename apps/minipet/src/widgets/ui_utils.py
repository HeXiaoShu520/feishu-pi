# coding:utf-8
"""Qt UI 公共小工具。"""

from PySide6.QtCore import QPoint
from PySide6.QtWidgets import QApplication


def clamp_popup_pos(pos, size, anchor, margin=4):
    """把弹窗位置限制在 anchor 所在屏幕内。"""
    screen = QApplication.screenAt(anchor) or QApplication.primaryScreen()
    if screen is None:
        return pos
    area = screen.availableGeometry()
    x = max(area.left() + margin, min(pos.x(), area.right() - size.width() - margin))
    y = max(area.top() + margin, min(pos.y(), area.bottom() - size.height() - margin))
    return QPoint(x, y)
