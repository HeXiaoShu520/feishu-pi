# coding:utf-8
"""
桌宠拖拽、掉落和鼠标交互逻辑。

把鼠标事件处理从 DesktopPet 窗口类中分离出来，让窗口类只负责 Qt 事件转发，
交互细节在此集中维护，便于单独测试和复用。
"""
from pathlib import Path

from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QPoint, Qt
from PySide6.QtGui import QCursor
from PySide6.QtWidgets import QApplication

import config
from pet.desktop_hover import arm_hover_menu_from_cursor, disarm_hover_menu

GRAVITY = 0.65  # 掉落模拟的重力加速度（像素/帧²）


def _image_to_data_url(image):
    """把 QImage 编码成 base64 PNG data URL，供弹窗预览拖入图片。"""
    data = QByteArray()
    buffer = QBuffer(data)
    buffer.open(QIODevice.WriteOnly)
    image.save(buffer, 'PNG')
    return 'data:image/png;base64,' + bytes(data.toBase64()).decode('ascii')


def drop_payload_from_mime(owner, mime):
    # 按 URL > 图片 > 纯文本的优先级解析拖入内容，
    # 因为拖文件时 mime 同时包含 URL 和文本，必须先判断 URL 避免误识别为纯文本。
    if mime is None:
        return None
    if mime.hasUrls():
        items = []
        has_file = False
        for url in mime.urls():
            item = drop_item_from_url(url)
            if item:
                has_file = has_file or item.get('kind') == 'file'
                items.append(item)
        if items:
            kind = 'file' if has_file else 'url'
            return {'kind': kind, 'items': items, 'preview': drop_preview(items)}
    if mime.hasImage():
        image = mime.imageData()
        return {
            'kind': 'image',
            'items': [{'kind': 'image', 'name': '拖入的图片', 'data_url': _image_to_data_url(image)}],
            'preview': '一张图片，可以识别文字、总结或发到飞书。',
        }
    if mime.hasText():
        text = (mime.text() or '').strip()
        if text:
            kind = 'url' if looks_like_url(text) else 'text'
            return {'kind': kind, 'items': [{'kind': kind, 'text': text}], 'preview': text}
    return None


def drop_item_from_url(url):
    """把单个 QUrl 转成拖放条目：本地文件标记为 file，否则标记为 url。"""
    if url.isLocalFile():
        path = url.toLocalFile()
        name = Path(path).name or path
        return {'kind': 'file', 'path': path, 'name': name}
    text = url.toString()
    if text:
        return {'kind': 'url', 'url': text, 'name': text}
    return None


def looks_like_url(text):
    """粗略判断一段文本是否是 URL。"""
    lower = text.lower()
    return lower.startswith(('http://', 'https://', 'file://')) or '://' in lower


def drop_preview(items):
    """生成拖放内容的预览文本，最多列 3 项名称，多余用“等 N 项”表示。"""
    names = [item.get('name') or item.get('url') or item.get('text') or item.get('kind') for item in items[:3]]
    text = '、'.join(names)
    if len(items) > 3:
        text += ' 等 %d 项' % len(items)
    return text


def handle_mouse_press(owner, event):
    """处理鼠标按下：左键记录拖拽起点，返回 True 表示事件已消费。"""
    if event.button() == Qt.LeftButton:
        owner.hover_inside_visible = True
        disarm_hover_menu(owner)
        owner.left_pressed = True
        owner.was_dragging = False
        owner.mouse_drag_pos = event.globalPos() - owner.pos()
        owner.press_global_pos = event.globalPos()
        owner.last_mouse = [QCursor.pos()]
        event.accept()
        return True
    return False


def handle_mouse_move(owner, event):
    """处理鼠标移动：超过拖拽阈值进入拖拽，拖拽中实时移动窗口并记录鼠标轨迹。"""
    # 拖拽判定用 manhattanLength >= 6 而非立即触发，避免普通点击抖动误触发拖拽动画。
    if not owner.left_pressed:
        if owner.quick_menu is None:
            arm_hover_menu_from_cursor(owner)
        return True
    if not owner.is_dragging and (event.globalPos() - owner.press_global_pos).manhattanLength() >= 6:
        owner.is_dragging = True
        owner.was_dragging = True
        owner.hover_inside_visible = True
        disarm_hover_menu(owner)
        close_interaction_popups(owner)
        owner.fall_timer.stop()
        if owner.anim_thread:
            owner.anim_thread.worker.play([owner.profile.drag])
    if owner.is_dragging:
        owner.move(event.globalPos() - owner.mouse_drag_pos)
        owner._sync_voice_popup_position()
        owner.last_mouse.append(QCursor.pos())
        owner.last_mouse = owner.last_mouse[-4:]
        event.accept()
    return True


def handle_mouse_release(owner, event):
    """处理鼠标释放：右键交给手势计数，左键拖拽结束时按配置掉落或原地落位。"""
    if event.button() == Qt.RightButton:
        owner.record_right_click()
        event.accept()
        return True
    if event.button() != Qt.LeftButton:
        return False
    owner.left_pressed = False
    if not owner.was_dragging:
        event.accept()
        return True
    owner.is_dragging = False
    update_drag_speed(owner)
    owner._set_current_screen_from_point(owner._pet_reference_point())
    if config.app_config.get('allow_drop', True):
        config.on_floor = False
        if owner.anim_thread:
            owner.anim_thread.worker.play([owner.profile.fall])
        owner.fall_timer.start(16)
    else:
        owner.move(limit_position(owner, owner.x(), owner.y()))
        owner._resume_random_animation()
    event.accept()
    return True


def close_interaction_popups(owner):
    """拖拽开始时关闭所有悬浮弹窗（快捷菜单、彩蛋菜单、输入框）。"""
    if owner.quick_menu is not None:
        owner.quick_menu.close()
    if owner.easter_menu is not None:
        owner.easter_menu.close()
    if owner.input_popup is not None:
        owner.input_popup.close()


def update_drag_speed(owner):
    """根据最近几帧鼠标轨迹估算松手时的抛出速度。"""
    # 取最近几帧鼠标位置的平均速度而非最后一帧瞬时速度，
    # 防止松手瞬间鼠标静止导致抛出速度为零。
    if len(owner.last_mouse) < 2:
        return
    p1 = owner.last_mouse[-1]
    p0 = owner.last_mouse[0]
    config.drag_speed_x = (p1.x() - p0.x()) / max(1, len(owner.last_mouse))
    config.drag_speed_y = (p1.y() - p0.y()) / max(1, len(owner.last_mouse))


def limit_position(owner, x, y):
    """把窗口坐标限制在当前屏幕范围内（底部为地面），返回修正后的 QPoint。"""
    left = owner.current_screen.left() - owner.width() // 2
    right = owner.current_screen.right() - owner.width() // 2
    top = owner.current_screen.top() - owner.height() // 2
    bottom = owner.floor_y
    return QPoint(max(left, min(int(x), right)), max(top, min(int(y), bottom)))


def fall_step(owner):
    """掉落定时器的单帧步进：积分重力、跨屏检测、侧边反弹与落地收尾。"""
    # 每帧增加固定重力加速度模拟自由落体，碰到侧边反弹并衰减水平速度，
    # 落地后归零速度并恢复随机动画。
    config.drag_speed_y += GRAVITY
    nx = owner.x() + config.drag_speed_x
    ny = owner.y() + config.drag_speed_y
    screen = QApplication.screenAt(owner._pet_reference_point(nx, ny))
    if screen is not None and screen.availableGeometry() != owner.current_screen:
        owner._set_current_screen_from_point(owner._pet_reference_point(nx, ny))
    limited = limit_position(owner, nx, ny)
    hit_side = limited.x() != int(nx)
    hit_floor = limited.y() >= owner.floor_y
    if hit_side:
        config.drag_speed_x = -config.drag_speed_x * 0.5
    owner.move(limited)
    owner._sync_voice_popup_position()
    if hit_floor:
        owner.fall_timer.stop()
        config.on_floor = True
        config.drag_speed_x = 0
        config.drag_speed_y = 0
        owner._resume_random_animation()
