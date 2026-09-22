# coding:utf-8
"""
桌宠动作命令集合。

将动画控制、图像更新、位置移动等操作从 DesktopPet 主窗口中抽出，
以模块级函数形式提供，owner 参数始终是 DesktopPet 实例。
这样做的好处是业务逻辑可在不实例化 QWidget 的情况下单独测试。
"""

from PySide6.QtCore import QRect, QSize, Qt

import config
from pet.animation import AnimationThread
from pet.pet_assets import _pixmap_bounds


def start_animation(owner):
    owner.anim_thread = AnimationThread(owner.profile, owner)
    owner.anim_thread.worker.image_changed.connect(owner._set_image)
    owner.anim_thread.worker.move_requested.connect(owner._move_by)
    owner.anim_thread.worker.finished.connect(owner._resume_random_animation)
    owner.anim_thread.start()


def stop_animation(owner):
    thread = owner.anim_thread
    owner.anim_thread = None
    if thread is None:
        return
    # 先断开信号，防止停止后残留的排队帧回调打到 owner（此时可能已加载新角色）
    worker = thread.worker
    worker.image_changed.disconnect(owner._set_image)
    worker.move_requested.disconnect(owner._move_by)
    worker.finished.disconnect(owner._resume_random_animation)
    thread.stop()
    # 线程以 owner 为 parent，不 deleteLater 的话对象连同 worker 持有的整套
    # 角色帧 QPixmap 会永久驻留；自动轮换每次切换泄漏一个完整模型
    if thread.isRunning():
        thread.finished.connect(thread.deleteLater)
    else:
        thread.deleteLater()


def set_image(owner, pixmap, anchor, act=None):
    # 每次换帧时同步更新 visible_bounds，确保碰撞区域和弹窗锚点跟随当前帧的非透明区域，
    # 而不是用上一帧的尺寸导致偏移。
    config.previous_anchor = config.current_anchor
    config.current_anchor = list(anchor or [0, 0])
    scale = float(config.app_config.get('scale', 1.0))
    width = max(1, int(pixmap.width() * scale))
    height = max(1, int(pixmap.height() * scale))
    owner.current_frame_size = QSize(pixmap.width(), pixmap.height())
    if act is not None:
        owner.visible_bounds = act.get_bounds(pixmap, scale)
    else:
        # 预览帧（load_pet_preview）没有 act，仍要按非透明区域取边界，
        # 否则完整模型加载完成前锚点会带上整帧透明边距，卡片明显偏高。
        left, top, bounds_width, bounds_height = _pixmap_bounds(pixmap)
        owner.visible_bounds = QRect(int(left * scale), int(top * scale), max(1, int(bounds_width * scale)), max(1, int(bounds_height * scale)))
    owner.label.setFixedSize(width, height)
    owner.label.setPixmap(pixmap.scaled(width, height, Qt.KeepAspectRatio, Qt.SmoothTransformation))
    reset_size(owner, keep_position=True, apply_image=False)


def reset_size(owner, keep_position=True, apply_image=True):
    # keep_position=True 时保持当前坐标并重新限位（用于缩放设置变更），
    # keep_position=False 时将宠物放置到屏幕底部中央（用于首次加载或切换角色）。
    if not owner.profile:
        return
    old_pos = owner.pos()
    scale = float(config.app_config.get('scale', 1.0))
    owner.setFixedSize(max(1, int(owner.profile.width * scale)), max(1, int(owner.profile.height * scale)))
    if keep_position:
        owner._set_current_screen_from_point(owner._pet_reference_point(old_pos.x(), old_pos.y()))
        owner.move(owner._limit_position(old_pos.x(), old_pos.y()))
    else:
        owner.floor_y = owner.current_screen.bottom() - owner.height() + 1
        owner.move(owner.current_screen.center().x() - owner.width() // 2, owner.floor_y)
    if apply_image and config.current_image:
        set_image(owner, config.current_image, config.current_anchor)
    owner._sync_voice_popup_position()


def move_by(owner, dx, dy):
    owner.move(owner._limit_position(owner.x() + dx, owner.y() + dy))
    owner._sync_voice_popup_position()


def resume_random_animation(owner):
    if owner.anim_thread:
        owner.anim_thread.worker.resume()


def play_action(owner, name):
    if not owner.profile or name not in owner.profile.acts:
        return
    if owner.anim_thread:
        owner.anim_thread.worker.play([owner.profile.acts[name]])


def pat(owner):
    act = owner.profile.patpat.get(2) or owner.profile.default
    if owner.anim_thread:
        owner.anim_thread.worker.play([act])
