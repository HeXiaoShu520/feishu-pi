# coding:utf-8
"""验证桌宠右键打开横向快捷菜单及其彩蛋入口。"""

import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication, QPushButton, QWidget

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from pet.desktop_interactions import handle_mouse_press, handle_mouse_release
from pet.desktop_pet import DesktopPet
from widgets.menus.pet_menus import PetQuickMenu, build_pet_context_menu


class PetContextMenuTest(unittest.TestCase):
    """覆盖桌宠右键事件的最小路由逻辑。"""

    def test_context_menu_does_not_open_menu(self):
        """Qt 上下文事件本身不能触发任何菜单。"""
        owner = Mock()
        event = Mock()

        DesktopPet.contextMenuEvent(owner, event)

        owner.show_quick_menu.assert_not_called()
        event.accept.assert_called_once_with()

    def test_right_click_release_records_gesture(self):
        """右键释放是唯一的多击计数入口。"""
        owner = Mock()
        event = Mock()
        event.button.return_value = Qt.RightButton

        self.assertTrue(handle_mouse_release(owner, event))
        owner.record_right_click.assert_called_once_with()
        event.accept.assert_called_once_with()

    def test_right_press_is_not_intercepted_by_interaction_layer(self):
        """交互层必须把右键交还 Qt 生成标准上下文菜单事件。"""
        event = Mock()
        event.button.return_value = Qt.RightButton

        self.assertFalse(handle_mouse_press(Mock(), event))
        event.accept.assert_not_called()

    def test_right_release_is_consumed_by_gesture_layer(self):
        """交互层必须把右键释放交给多击手势计数器。"""
        owner = Mock()
        event = Mock()
        event.button.return_value = Qt.RightButton

        self.assertTrue(handle_mouse_release(owner, event))
        owner.record_right_click.assert_called_once_with()
        event.accept.assert_called_once_with()

    def test_tray_menu_contains_easter_shop_action(self):
        """托盘菜单中的彩蛋入口应调用桌宠既有打开方法。"""
        app = QApplication.instance() or QApplication([])
        owner = QWidget()
        owner.show_settings = Mock()
        owner.chat_requested = Mock()
        owner.voice_chat_requested = Mock()
        owner.show_easter_menu = Mock()
        owner.quit = Mock()
        owner.profile = None

        menu = build_pet_context_menu(owner)
        action = next(item for item in menu.actions() if item.text() == '彩蛋小铺')
        action.trigger()

        owner.show_easter_menu.assert_called_once_with()
        menu.deleteLater()
        app.processEvents()

    def test_quick_menu_has_no_easter_button(self):
        """宠物上方横向快捷菜单不包含彩蛋小铺按钮。"""
        app = QApplication.instance() or QApplication([])
        on_easter = Mock()
        menu = PetQuickMenu(100, 100, 140, Mock(), Mock(), Mock(), Mock(), Mock(), parent=QWidget())
        easter_buttons = [button for button in menu.findChildren(QPushButton) if button.toolTip() == '彩蛋小铺']

        self.assertEqual(easter_buttons, [])
        menu.close()
        app.processEvents()


if __name__ == '__main__':
    unittest.main()
