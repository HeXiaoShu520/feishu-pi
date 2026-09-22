# coding:utf-8
# 快速菜单悬停触发逻辑：通过采样鼠标轨迹判断是"水平滑入"宠物，而非随机经过。
# 用模块级函数而非类方法实现，方便被 DesktopPet 按需混入，避免多继承耦合。
import time

from PySide6.QtCore import QTimer
from PySide6.QtGui import QCursor


def start_hover_tracking(owner):
    """启动悬停追踪：开启鼠标轨迹采样定时器与单次触发的菜单显示定时器。"""
    # owner 是 DesktopPet 实例，将追踪状态挂载到 owner 上，保持组件无状态、可重置
    owner.hover_menu_armed = False
    owner.hover_inside_visible = False
    owner.hover_mouse_trace = []
    owner.hover_trace_timer = QTimer(owner)
    owner.hover_trace_timer.timeout.connect(lambda: sample_hover_mouse_trace(owner))
    owner.hover_trace_timer.start(50)
    owner.hover_timer = QTimer(owner)
    owner.hover_timer.setSingleShot(True)
    owner.hover_timer.timeout.connect(lambda: show_quick_menu_from_hover(owner))


def sample_hover_mouse_trace(owner):
    """每 50ms 采样一次全局鼠标位置，仅保留最近 0.45s 内的轨迹点。"""
    pos = QCursor.pos()
    now = time.monotonic()
    owner.hover_mouse_trace.append((now, pos))
    owner.hover_mouse_trace = [(t, p) for t, p in owner.hover_mouse_trace if now - t <= 0.45]


def is_horizontal_hover_entry(owner):
    """判断最近 0.35s 的鼠标轨迹是否构成一次有效的水平滑入。"""
    # 只有横向位移足够且水平分量大于垂直分量 1.6 倍，才判定为"从侧面滑入"，
    # 过滤掉用户在宠物附近随机移动鼠标时的误触发
    if len(owner.hover_mouse_trace) < 2:
        return False
    now = time.monotonic()
    points = [(t, p) for t, p in owner.hover_mouse_trace if now - t <= 0.35]
    if len(points) < 2:
        return False
    start = points[0][1]
    end = points[-1][1]
    dx = end.x() - start.x()
    dy = end.y() - start.y()
    adx = abs(dx)
    ady = abs(dy)
    return adx >= 10 and adx >= ady * 1.6


def arm_hover_menu_from_cursor(owner):
    """武装悬停菜单：重置状态等待下次有效滑入触发。"""
    disarm_hover_menu(owner)


def disarm_hover_menu(owner):
    """解除武装：清空标志位并停掉待触发的定时器。"""
    owner.hover_inside_visible = False
    owner.hover_menu_armed = False
    owner.hover_timer.stop()


def show_quick_menu_from_hover(owner):
    """定时器到期回调：仅当处于武装状态时才弹出快速菜单（一次性）。"""
    if not owner.hover_menu_armed:
        return
    owner.hover_menu_armed = False
    owner.show_quick_menu()


def close_quick_menu_if_mouse_away(owner):
    """鼠标离开宠物和菜单后关闭快速菜单。"""
    # 鼠标既不在宠物身上也不在菜单上时才关闭，防止用户移向菜单时菜单闪烁消失
    if owner.quick_menu is None:
        return
    cursor = QCursor.pos()
    if owner.geometry().contains(cursor):
        return
    if owner.quick_menu.geometry().contains(cursor):
        return
    owner.quick_menu.close()
