# coding:utf-8
"""
桌面宠物主窗口和桌面交互组件。

这个文件目前集中放了桌宠窗口相关的 UI：
- PetInputPopup：双击桌宠弹出的快速输入框，支持粘贴/拖入图片。
- PetVoicePopup / VoiceOrbWidget：桌宠旁边的轻量语音聊天状态球。
- DesktopPet：透明桌宠窗口、动画播放、拖拽/掉落、托盘菜单和快捷菜单。

后续如果继续拆文件，优先把输入弹窗和语音球组件拆到独立模块。
"""

import random
import time

from PySide6.QtCore import QPoint, QRect, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QDragEnterEvent, QDropEvent
from PySide6.QtWidgets import QApplication, QLabel, QVBoxLayout, QWidget

import config
from pet.desktop_actions import move_by as move_pet_by
from pet.desktop_actions import pat as pat_pet
from pet.desktop_actions import play_action as play_pet_action
from pet.desktop_actions import reset_size as reset_pet_size
from pet.desktop_actions import resume_random_animation, set_image as set_pet_image
from pet.desktop_actions import start_animation, stop_animation
from pet.desktop_easter import show_coin as show_coin_popup
from pet.desktop_easter import show_dice as show_dice_popup
from pet.desktop_easter import show_easter_menu as show_easter_popup_menu
from pet.desktop_easter import show_fortune as show_fortune_popup
from pet.desktop_easter import show_gacha as show_gacha_popup
from pet.desktop_easter import show_magic_conch as show_magic_conch_popup
from pet.desktop_easter import toggle_wooden_fish as toggle_wooden_fish_popup
from pet.desktop_hover import arm_hover_menu_from_cursor, close_quick_menu_if_mouse_away, disarm_hover_menu, start_hover_tracking
from pet.desktop_interactions import drop_payload_from_mime, fall_step, handle_mouse_move, handle_mouse_press, handle_mouse_release, limit_position
from pet.desktop_tray import build_menu, hide_tray, setup_tray
from pet.desktop_windows import show_chat_window
from pet.pet_assets import load_pet_preview, load_pet_profile
from widgets.pet_input_popup import PetInputPopup
from widgets.pet_voice_popup import PetVoicePopup
from widgets.menus.pet_menus import PetDropIntentPopup, PetQuickMenu


class DesktopPet(QWidget):
    """桌面宠物主窗口。

    负责透明窗口显示、角色动画、拖拽/掉落、多屏找回、托盘菜单、快捷菜单、
    聊天窗口的打开/关闭。业务请求通过 Qt 信号交给 MiniPetApp，
    避免主窗口直接调用 Agent 内核。
    """

    show_settings = Signal()
    reply_card_text_requested = Signal(str, int, int, int)
    chat_prompt_submitted = Signal(object)
    drop_intent_submitted = Signal(dict, str)
    chat_requested = Signal()
    voice_chat_requested = Signal()
    voice_pause_requested = Signal()
    voice_stop_requested = Signal()
    share_screen_requested = Signal(bool)
    pet_changed = Signal(str)
    quit_requested = Signal()
    _profile_loaded = Signal(int, str, object, object)

    def __init__(self, screens, parent=None):
        """初始化窗口、状态字段、掉落定时器和托盘，并加载默认角色。"""
        super().__init__(parent)
        self.screens = screens
        self.current_screen = screens[0].availableGeometry()
        config.screens = screens
        config.current_screen = screens[0]
        self.profile = None
        self._profile_load_thread = None
        self._profile_load_request = 0
        self.anim_thread = None
        self.chat_window = None
        self.tray = None
        self.context_menu = None
        self.input_popup = None
        self.voice_popup = None
        self.quick_menu = None
        self._share_screen_active = False
        self._voice_chat_active = False
        self.drop_popup = None
        self.wooden_fish_popup = None
        self.fortune_stick_popup = None
        self.easter_menu = None
        self.magic_conch_popup = None
        self.gacha_popup = None
        self.dice_popup = None
        self.coin_popup = None
        self.block_quick_menu_until = 0.0
        self.right_click_count = 0
        self.right_click_timer = QTimer(self)
        self.right_click_timer.setSingleShot(True)
        self.right_click_timer.timeout.connect(self._finish_right_click_gesture)
        self.current_frame_size = QSize(0, 0)
        self.visible_bounds = QRect()
        self.is_dragging = False
        self._quit_requested = False
        self.left_pressed = False
        self.was_dragging = False
        self.mouse_drag_pos = QPoint(0, 0)
        self.press_global_pos = QPoint(0, 0)
        self.last_mouse = []
        self.fall_timer = QTimer(self)
        self.fall_timer.timeout.connect(self._fall_step)
        self.floor_y = 0
        start_hover_tracking(self)
        self._init_window()
        self._init_ui()
        self._profile_loaded.connect(self._on_profile_loaded)
        self.load_pet(config.app_config.get('default_pet') or (config.get_pet_list()[0] if config.get_pet_list() else ''))
        self.show()
        self._setup_tray()

    def _init_window(self):
        # Tool | FramelessWindowHint 让窗口不出现在任务栏，NoDropShadowWindowHint 避免 Windows 给透明窗口加阴影。
        # on_top 由用户设置控制，不强制置顶，方便全屏应用正常遮盖桌宠。
        flags = Qt.Tool | Qt.FramelessWindowHint | Qt.NoDropShadowWindowHint
        if config.app_config.get('on_top', True):
            flags |= Qt.WindowStaysOnTopHint
        self.setWindowFlags(flags)
        self.setAutoFillBackground(False)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setMouseTracking(True)
        self.setAcceptDrops(True)

    def _init_ui(self):
        """放置角色图片标签：透明背景、底部居中、不拦截鼠标事件。"""
        self.label = QLabel(self)
        self.label.setMouseTracking(True)
        self.label.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        self.label.setScaledContents(True)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.label, 0, Qt.AlignBottom | Qt.AlignHCenter)

    def load_pet(self, pet_name):
        """切换角色：先显示预览帧，再在后台线程加载完整资源。"""
        if not pet_name:
            return
        self._stop_animation()
        self._profile_load_request += 1
        request_id = self._profile_load_request
        try:
            preview, anchor = load_pet_preview(pet_name)
            self._set_image(preview, anchor)
        except Exception as error:
            print('[DesktopPet] 预览加载失败: %s' % error, flush=True)
        self._start_profile_load(request_id, pet_name)

    def _start_profile_load(self, request_id, pet_name):
        """在线程中加载完整角色资源，避免阻塞界面。"""
        from PySide6.QtCore import QThread

        if getattr(self, '_quit_requested', False):
            return
        thread = QThread(self)
        self._profile_load_thread = thread
        thread.started.connect(lambda: self._load_profile_in_thread(thread, request_id, pet_name))
        thread.start()

    def _load_profile_in_thread(self, thread, request_id, pet_name):
        """线程内执行资源加载，结果通过信号带回主线程。"""
        try:
            profile = load_pet_profile(pet_name)
            self._profile_loaded.emit(request_id, pet_name, profile, None)
        except Exception as error:
            self._profile_loaded.emit(request_id, pet_name, None, error)
        thread.quit()

    def _on_profile_loaded(self, request_id, pet_name, profile, error):
        """完整资源加载完成回调：丢弃过期请求，应用模型并启动动画。"""
        if getattr(self, '_quit_requested', False):
            return
        if request_id != self._profile_load_request:
            self._discard_profile_load_thread()
            return
        self._discard_profile_load_thread()
        if error is not None or profile is None:
            print('[DesktopPet] 完整模型加载失败: %s' % (error or pet_name), flush=True)
            return
        self.profile = profile
        config.current_pet = pet_name
        config.app_config['default_pet'] = pet_name
        config.save_app_config()
        self.setWindowTitle(f'{config.APP_DISPLAY_NAME} - {config.pet_display_name()}')
        self._set_image(profile.default.images[0], profile.default.anchor)
        self._reset_size(keep_position=False)
        self._start_animation()
        self._setup_tray()
        self.pet_changed.emit(pet_name)

    def _start_animation(self):
        start_animation(self)

    def _stop_animation(self):
        stop_animation(self)

    def _discard_profile_load_thread(self):
        """销毁已完成任务的资源加载线程：线程对象挂在 self 上，不清理会随每次切换累积。"""
        thread = self._profile_load_thread
        self._profile_load_thread = None
        if thread is None:
            return
        if thread.isRunning():
            # 加载线程发出结果信号后才 quit，此时可能还没跑完事件循环，
            # 等 finished 再删，避免销毁仍在运行的线程
            thread.finished.connect(thread.deleteLater)
        else:
            thread.deleteLater()

    def _stop_profile_load(self):
        """退出时停止角色资源加载线程，避免线程回调已销毁的窗口。"""
        thread = self._profile_load_thread
        self._profile_load_thread = None
        if thread is None or not thread.isRunning():
            return
        thread.requestInterruption()
        thread.quit()
        if not thread.wait(1000):
            print('[DesktopPet] 角色资源线程未及时退出，强制终止', flush=True)
            thread.terminate()
            thread.wait(1000)
        thread.deleteLater()

    def _set_image(self, pixmap, anchor, act=None):
        set_pet_image(self, pixmap, anchor, act=act)

    def _reset_size(self, keep_position=True, set_image=True):
        reset_pet_size(self, keep_position=keep_position, apply_image=set_image)

    def _screen_at_point(self, point):
        """根据坐标查找所在屏幕，多级降级保证不返回 None。"""
        # QApplication.screenAt 在多屏场景下可能返回 None（点落在屏幕间隙），
        # 依次降级到当前屏幕、主屏幕，确保始终有有效屏幕可用。
        screen = QApplication.screenAt(point)
        if screen is not None:
            return screen
        screen = self.screen()
        if screen is not None:
            return screen
        screen = QApplication.primaryScreen()
        if screen is not None:
            return screen
        return self.screens[0] if self.screens else None

    def _pet_reference_point(self, x=None, y=None):
        """取角色“脚底中心”作为跨屏/地面判定的参考点。"""
        px = self.x() if x is None else int(x)
        py = self.y() if y is None else int(y)
        return QPoint(px + self.width() // 2, py + self.height())

    def _set_current_screen_from_point(self, point):
        """把当前屏幕切换为参考点所在的屏幕，并重算地面高度。"""
        screen = self._screen_at_point(point)
        if screen is not None:
            config.current_screen = screen
            self.current_screen = screen.availableGeometry()
        self.floor_y = self.current_screen.bottom() - self.height() + 1
        return self.current_screen

    def _setup_tray(self):
        setup_tray(self)

    def _build_menu(self, include_actions=False):
        return build_menu(self, include_actions=include_actions)

    def enterEvent(self, event):
        """鼠标进入角色时预布防悬浮菜单检测。"""
        arm_hover_menu_from_cursor(self)
        super().enterEvent(event)

    def leaveEvent(self, event):
        """鼠标离开时解除悬浮菜单，并延迟关闭可能已弹出的快捷菜单。"""
        disarm_hover_menu(self)
        QTimer.singleShot(220, lambda: close_quick_menu_if_mouse_away(self))
        super().leaveEvent(event)

    def contextMenuEvent(self, event):
        # 右键手势由 mouseReleaseEvent 统一计数，禁止 Qt 单击上下文菜单触发快捷菜单。
        event.accept()

    def record_right_click(self):
        """记录一次右键释放，并在短时间窗口内识别双击或四击。"""
        self.right_click_count += 1
        if self.right_click_count == 3:
            self.right_click_timer.stop()
            self.right_click_count = 0
            self.show_easter_menu()
            return
        self.right_click_timer.start(350)

    def _finish_right_click_gesture(self):
        """结算右键多击手势，单击保持无动作。"""
        count = self.right_click_count
        self.right_click_count = 0
        if count == 2:
            self.show_quick_menu()

    def dragEnterEvent(self, event: QDragEnterEvent):
        """能解析出拖放内容时接受拖入，否则交给默认处理。"""
        if drop_payload_from_mime(self, event.mimeData()) is not None:
            event.acceptProposedAction()
            disarm_hover_menu(self)
            return
        super().dragEnterEvent(event)

    def dropEvent(self, event: QDropEvent):
        """解析拖放内容并弹出意图选择卡片。"""
        payload = drop_payload_from_mime(self, event.mimeData())
        if payload is None:
            super().dropEvent(event)
            return
        event.acceptProposedAction()
        self._show_drop_popup(payload)

    def _show_drop_popup(self, payload):
        """在角色头顶弹出拖放意图选择卡片。"""
        if self.drop_popup is not None:
            self.drop_popup.close()
        x, y = self.reply_card_anchor()
        self.drop_popup = PetDropIntentPopup(payload, x, y, self)
        self.drop_popup.intent_selected.connect(self.drop_intent_submitted.emit)
        self.drop_popup.destroyed.connect(lambda: setattr(self, 'drop_popup', None))
        self.pat()

    def mousePressEvent(self, event):
        """鼠标按下转交交互模块处理。"""
        if not handle_mouse_press(self, event):
            super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        """鼠标移动转交交互模块处理。"""
        if not handle_mouse_move(self, event):
            super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        """鼠标释放转交交互模块处理。"""
        if not handle_mouse_release(self, event):
            super().mouseReleaseEvent(event)

    def show_easter_menu(self):
        """打开彩蛋功能菜单。"""
        show_easter_popup_menu(self)

    def show_magic_conch(self):
        """打开魔法海螺弹窗。"""
        show_magic_conch_popup(self)

    def show_gacha(self):
        """打开扭蛋弹窗。"""
        show_gacha_popup(self)

    def show_dice(self):
        """打开掷骰子弹窗。"""
        show_dice_popup(self)

    def show_coin(self):
        """打开金币弹窗。"""
        show_coin_popup(self)

    def show_fortune(self):
        """打开签筒求签弹窗。"""
        show_fortune_popup(self)

    def toggle_wooden_fish(self):
        """打开/关闭电子木鱼弹窗。"""
        toggle_wooden_fish_popup(self)

    def show_quick_menu(self):
        # 菜单刚关闭后的短时间内拒绝重开，避免同一次点击先关菜单又触发新菜单。
        if time.monotonic() < self.block_quick_menu_until:
            return
        if self.easter_menu is not None:
            self.easter_menu.close()
        if self.quick_menu is not None and self.quick_menu.isVisible():
            self.quick_menu.close()
            return
        x, top_y, bottom_y = self.quick_menu_anchor()
        self.quick_menu = PetQuickMenu(x, top_y, bottom_y, self.show_settings.emit, self.chat_requested.emit, self._on_voice_chat_requested, self.quit, self._on_share_screen_toggle, self._randomize_pet, share_screen_active=self._share_screen_active, voice_chat_active=self._voice_chat_active, parent=self)
        self.quick_menu.destroyed.connect(lambda: setattr(self, 'quick_menu', None))

    def _randomize_pet(self):
        """从可用模型中随机切换到另一个宠物。"""
        pets = [pet for pet in config.get_pet_list() if pet != config.current_pet]
        if pets:
            self.load_pet(random.choice(pets))

    def randomize_pet(self):
        """随机切换到另一个宠物模型（供自动轮换等外部调用）。"""
        self._randomize_pet()

    def _on_share_screen_toggle(self, checked):
        self._share_screen_active = checked
        self.share_screen_requested.emit(checked)

    def _on_voice_chat_requested(self):
        self.voice_chat_requested.emit()

    def set_voice_chat_active(self, active):
        self._voice_chat_active = bool(active)

    def mouseDoubleClickEvent(self, event):
        # 左键双击打开输入框，右键由释放事件统一计数。
        if event.button() == Qt.LeftButton:
            disarm_hover_menu(self)
            if self.quick_menu is not None:
                self.quick_menu.close()
            self.ask_pet()
            event.accept()
            return
        if event.button() == Qt.RightButton:
            event.accept()
            return
        super().mouseDoubleClickEvent(event)

    def ask_pet(self):
        """打开（或聚焦已有的）快速输入框，提交结果经信号发给主应用。"""
        if self.input_popup is not None and self.input_popup.isVisible():
            self.input_popup.raise_()
            self.input_popup.activateWindow()
            return
        x, y = self.reply_card_anchor()
        self.input_popup = PetInputPopup(x, y, self)
        self.input_popup.submitted.connect(self.chat_prompt_submitted.emit)
        self.input_popup.destroyed.connect(lambda: setattr(self, 'input_popup', None))

    def show_voice_popup(self, anchor=None, anchor_mode='pet', initial_state='idle', initial_text=''):
        """显示语音状态球：已存在则移动到新锚点，否则按初始状态创建。"""
        if anchor is None:
            anchor = self.reply_card_anchor()
            anchor_mode = 'pet'
        x, y = anchor
        if self.voice_popup is not None and self.voice_popup.isVisible():
            self.voice_popup.move_to_anchor(x, y, smooth=False, anchor_mode=anchor_mode)
            self.voice_popup.raise_()
            return self.voice_popup
        self.voice_popup = PetVoicePopup(
            x,
            y,
            self,
            anchor_mode=anchor_mode,
            initial_state=initial_state,
            initial_text=initial_text,
        )
        self.voice_popup.pause_requested.connect(self.voice_pause_requested.emit)
        self.voice_popup.stop_requested.connect(self.voice_stop_requested.emit)
        self.voice_popup.destroyed.connect(lambda: setattr(self, 'voice_popup', None))
        return self.voice_popup

    def update_voice_popup(self, state, text='', anchor=None, anchor_mode='pet'):
        # 语音弹窗不存在时先创建再更新，已存在时只更新状态，
        # 避免弹窗闪烁或位置跳变。
        is_new = self.voice_popup is None
        popup = self.show_voice_popup(
            anchor=anchor,
            anchor_mode=anchor_mode,
            initial_state=state,
            initial_text=text,
        )
        if not is_new:
            popup.update_state(state, text)

    def close_voice_popup(self):
        """关闭并释放语音状态球。"""
        if self.voice_popup is not None:
            self.voice_popup.close()
            self.voice_popup = None

    def _fall_step(self):
        fall_step(self)

    def _limit_position(self, x, y):
        return limit_position(self, x, y)

    def _sync_voice_popup_position(self):
        """跟随模式时让语音球贴合角色头顶，掉落中带漂浮效果。"""
        if self.voice_popup is not None and self.voice_popup.isVisible() and self.voice_popup.anchor_mode == 'pet':
            x, y = self.reply_card_anchor()
            self.voice_popup.move_to_anchor(x, y, floaty=self.fall_timer.isActive())

    def _move_by(self, dx, dy):
        move_pet_by(self, dx, dy)

    def _resume_random_animation(self):
        resume_random_animation(self)

    def play_action(self, name):
        play_pet_action(self, name)

    def pat(self):
        pat_pet(self)

    def show_chat(self, history=None, clear_history_callback=None, send_callback=None):
        show_chat_window(self, history=history, clear_history_callback=clear_history_callback, send_callback=send_callback)

    def _current_visible_bounds(self):
        """返回角色非透明区域，无效时退回整个窗口矩形。"""
        return self.visible_bounds if not self.visible_bounds.isNull() else QRect(0, 0, self.width(), self.height())

    def reply_card_anchor(self):
        """计算回复卡片锚点：角色头顶中心偏下 12px。"""
        # 锚点基于可见像素区域（非透明边界）而非整个窗口，
        # 保证弹出卡片紧贴角色头顶，不受大量透明边距影响。
        bounds = self._current_visible_bounds()
        center_x = self.x() + self.label.x() + bounds.left() + bounds.width() // 2
        top_y = self.y() + self.label.y() + bounds.top()
        return center_x, top_y + 12

    def easter_popup_anchor(self):
        """计算彩蛋弹窗锚点：角色头顶中心偏下 8px。"""
        bounds = self._current_visible_bounds()
        center_x = self.x() + self.label.x() + bounds.left() + bounds.width() // 2
        top_y = self.y() + self.label.y() + bounds.top()
        return center_x, top_y + 8

    def quick_menu_anchor(self):
        """计算快捷菜单锚点：返回头顶中心横坐标和角色上下边缘纵坐标。"""
        bounds = self._current_visible_bounds()
        center_x = self.x() + self.label.x() + bounds.left() + bounds.width() // 2
        top_y = self.y() + self.label.y() + bounds.top()
        bottom_y = self.y() + self.label.y() + bounds.bottom()
        return center_x, top_y, bottom_y

    def apply_settings(self):
        """设置页保存后重建窗口标志、标题、托盘并保持原位置。"""
        self._init_window()
        self.setWindowTitle(f'{config.APP_DISPLAY_NAME} - {config.pet_display_name()}')
        if self.chat_window is not None:
            self.chat_window.set_pet_name(config.pet_display_name())
        self.show()
        self._reset_size(keep_position=True)
        self._setup_tray()

    def quit(self):
        self.quit_requested.emit()

    def quit_now(self):
        """停止桌宠界面并请求 Qt 事件循环退出。"""
        if getattr(self, '_quit_requested', False):
            return
        self._quit_requested = True
        self._stop_profile_load()
        self._stop_animation()
        hide_tray(self)
        QApplication.quit()

    def closeEvent(self, event):
        self._stop_animation()
        super().closeEvent(event)
