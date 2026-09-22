# coding:utf-8
"""桌宠系统设置主窗口：基于 FluentWindow 的侧边导航容器，聚合各设置页。"""

import sys

from PySide6.QtCore import QEvent, QSize, Qt, Signal
from PySide6.QtGui import QCursor, QIcon, QMouseEvent
from PySide6.QtWidgets import QApplication, QWidget
from qfluentwidgets import FluentWindow
from qfluentwidgets import FluentIcon as FIF

import config
from windows.settings.basic_pages import BasicPage
from windows.settings.role_page import RolePage
from windows.settings.voice_pages import TTSPage, WakePage


def _icon(name):
    """从资源目录加载系统图标的小工具函数。"""
    return QIcon(str(config.RES_DIR / 'icons' / 'system' / name))


class SettingsWindow(FluentWindow):
    """设置主窗口：只装配桌宠外观、语音和唤醒词页面。"""

    settings_changed = Signal()
    pet_changed = Signal(str)

    def __init__(self):
        """构建窗口、注册各设置页信号并配置导航栏。"""
        super().__init__()
        self.setWindowTitle(f'{config.APP_DISPLAY_NAME} System')
        self.setWindowIcon(QIcon(str(config.avatar_path('pet'))))
        # 设置窗口使用相对屏幕尺寸，适配不同 DPI；每次打开时还会按实际所在屏幕再校准
        self.resize(self._initial_size())
        # _drag_pos 用于实现标题栏拖拽移动窗口，None 表示当前未在拖拽
        self._drag_pos = None
        self.installEventFilter(self)
        # 四个设置页实例化并接入统一信号（顺序即导航栏顺序）
        self.basic = BasicPage(self)
        self.basic.setObjectName('BasicPage')
        self.role = RolePage(self)
        self.role.setObjectName('RolePage')
        self.tts = TTSPage(self)
        self.tts.setObjectName('TTSPage')
        self.wake = WakePage(self)
        self.wake.setObjectName('WakePage')
        self.basic.settings_changed.connect(self.settings_changed)
        self.role.settings_changed.connect(self.settings_changed)
        self.tts.settings_changed.connect(self.settings_changed)
        self.wake.settings_changed.connect(self.settings_changed)
        self.role.pet_changed.connect(self.pet_changed)
        self.addSubInterface(self.basic, FIF.SETTING, '基础')
        self.addSubInterface(self.role, _icon('character.svg'), '角色')
        self.addSubInterface(self.tts, FIF.VOLUME, '语音')
        self.addSubInterface(self.wake, FIF.MICROPHONE, '唤醒词')
        self.navigationInterface.setExpandWidth(180)
        self.navigationInterface.setMinimumExpandWidth(180)
        self.navigationInterface.setCollapsible(False)
        self.navigationInterface.setMenuButtonVisible(False)
        self.navigationInterface.expand(useAni=False)

    def _is_title_drag_area(self, pos):
        """判断坐标是否落在自绘标题栏拖拽区（顶部 56px 内）。"""
        return pos.y() <= 56

    def eventFilter(self, obj, event):
        """全局事件过滤器：在标题栏区域按下/拖动时实现无边框窗口拖拽。"""
        if event.type() == QEvent.MouseButtonPress and event.button() == Qt.LeftButton:
            pos = event.position() if obj is self else obj.mapTo(self, event.position().toPoint())
            if self._is_title_drag_area(pos):
                self._drag_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
                return False
        if event.type() == QEvent.MouseMove and self._drag_pos is not None and event.buttons() & Qt.LeftButton:
            self.move(event.globalPosition().toPoint() - self._drag_pos)
            return True
        if event.type() == QEvent.MouseButtonRelease:
            self._drag_pos = None
        return super().eventFilter(obj, event)

    def _install_title_drag_filters(self):
        # 给所有位于标题栏区域内的子控件也安装事件过滤器，防止它们拦截鼠标事件导致拖拽失效
        for child in self.findChildren(QWidget):
            if child.mapTo(self, child.rect().topLeft()).y() <= 56:
                child.installEventFilter(self)

    def mousePressEvent(self, event: QMouseEvent):
        """标题栏区域左键按下即开始拖拽（与 eventFilter 逻辑双保险）。"""
        if event.button() == Qt.LeftButton and event.position().y() <= 56:
            self._drag_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent):
        """拖拽中：窗口跟随光标偏移移动。"""
        if self._drag_pos is not None and event.buttons() & Qt.LeftButton:
            self.move(event.globalPosition().toPoint() - self._drag_pos)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent):
        """释放鼠标即结束拖拽。"""
        self._drag_pos = None
        super().mouseReleaseEvent(event)

    def _keep_navigation_expanded(self):
        # FluentWindow 在某些交互后会折叠导航栏，每次 show 时强制还原为展开状态
        self.navigationInterface.setExpandWidth(180)
        self.navigationInterface.setMinimumExpandWidth(180)
        self.navigationInterface.setCollapsible(False)
        self.navigationInterface.setMenuButtonVisible(False)
        self.navigationInterface.expand(useAni=False)

    def showEvent(self, event):
        """每次打开设置窗口：同步下拉值、还原导航栏、重装拖拽过滤器、
        按当前所在屏幕校准尺寸，并重刷 Win11 背景特效防止变黑。"""
        super().showEvent(event)
        self.role.sync_from_config()
        self._keep_navigation_expanded()
        self._install_title_drag_filters()
        self._clamp_to_screen()
        self._refresh_background_effects()

    def _screen_for_window(self):
        """返回设置窗口实际所在（或即将出现）的屏幕，取不到时退回主屏。"""
        return self.screen() or QApplication.screenAt(QCursor.pos()) or QApplication.primaryScreen()

    def _initial_size(self):
        """按目标屏幕可用尺寸算出合理的初始窗口大小（逻辑像素）。"""
        screen = self._screen_for_window()
        if screen is None:
            return QSize(1020, 760)  # 无屏幕信息时的兜底尺寸
        geo = screen.availableGeometry()
        width = min(1020, max(900, int(geo.width() * 0.75)), geo.width())
        height = min(760, max(560, int(geo.height() * 0.80)), geo.height())
        return QSize(width, height)

    def _clamp_to_screen(self):
        """把窗口尺寸校准到不超过当前屏幕可用区域，且不小于舒适最小值。
        最大化状态下直接跳过：强行 resize 会把最大化"降级"成普通大小。"""
        if self.windowState() & Qt.WindowMaximized:
            return
        screen = self._screen_for_window()
        if screen is None:
            return
        geo = screen.availableGeometry()
        width = min(geo.width(), max(900, min(self.width(), geo.width())))
        height = min(geo.height(), max(560, min(self.height(), geo.height())))
        if (width, height) != (self.width(), self.height()):
            self.resize(width, height)

    def _refresh_background_effects(self):
        """Win11 下 Mica/毛玻璃合成层在反复 hide/show 后可能失效导致整窗变黑，
        每次显示时重刷一遍背景特效。Win10 无此合成层，直接跳过。"""
        if sys.platform != 'win32' or sys.getwindowsversion().build < 22000:
            return
        effect = getattr(self, 'windowEffect', None)
        if effect is None:
            return
        try:
            if hasattr(effect, 'removeBackgroundEffect'):
                effect.removeBackgroundEffect(int(self.winId()))
            if hasattr(effect, 'setMicaEffect'):
                effect.setMicaEffect(int(self.winId()))
            if hasattr(self, 'refreshBackgroundBlurEffect'):
                self.refreshBackgroundBlurEffect()
        except Exception:
            pass

    def reload_history(self):
        """占位接口：设置窗口无历史面板，保持与其他窗口接口一致。"""
        pass

    def shutdown(self):
        # 窗口关闭前主动停止所有后台 worker，避免线程在主窗口销毁后继续访问 UI 对象
        for page in (self.tts,):
            for worker_name in ('preview_worker',):
                worker = getattr(page, worker_name, None)
                if worker is not None and worker.isRunning():
                    worker.requestInterruption()
                    worker.quit()
                    worker.wait(2000)
                if hasattr(page, worker_name):
                    setattr(page, worker_name, None)

    def closeEvent(self, event):
        """关闭前先回收后台线程。"""
        self.shutdown()
        super().closeEvent(event)

    def show_window(self):
        """从托盘/快捷入口唤起窗口：还原最小化、置顶并激活。"""
        if self.isMinimized():
            self.showNormal()
        elif not self.isVisible():
            self.show()
        self._keep_navigation_expanded()
        self.raise_()
        self.activateWindow()
