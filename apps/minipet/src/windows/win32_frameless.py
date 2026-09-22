# coding:utf-8
"""Windows 无边框窗口的命中测试工具。"""

HTCLIENT = 1
HTCAPTION = 2
HTLEFT = 10
HTRIGHT = 11
HTTOP = 12
HTTOPLEFT = 13
HTTOPRIGHT = 14
HTBOTTOM = 15
HTBOTTOMLEFT = 16
HTBOTTOMRIGHT = 17
WM_NCHITTEST = 0x0084


def hit_test(x, y, width, height, title_height, resize_border, interactive_rects=(), maximized=False):
    """根据逻辑像素坐标返回 Windows 非客户区命中值。"""
    if not maximized:
        left = x < resize_border
        right = x >= width - resize_border
        top = y < resize_border
        bottom = y >= height - resize_border
        if top and left:
            return HTTOPLEFT
        if top and right:
            return HTTOPRIGHT
        if bottom and left:
            return HTBOTTOMLEFT
        if bottom and right:
            return HTBOTTOMRIGHT
        if left:
            return HTLEFT
        if right:
            return HTRIGHT
        if top:
            return HTTOP
        if bottom:
            return HTBOTTOM

    if y >= title_height or any(_contains(rect, x, y) for rect in interactive_rects):
        return HTCLIENT
    return HTCAPTION


def _contains(rect, x, y):
    left, top, width, height = rect
    return left <= x < left + width and top <= y < top + height
