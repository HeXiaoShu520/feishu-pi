# coding:utf-8

from PySide6.QtGui import QIcon
from PySide6.QtWidgets import QSystemTrayIcon

import config
from widgets.menus.pet_menus import build_pet_context_menu


def setup_tray(owner):
    if not QSystemTrayIcon.isSystemTrayAvailable():
        return
    if not owner.tray:
        owner.tray = QSystemTrayIcon(QIcon(str(config.avatar_path('pet'))), owner)
    new_menu = build_pet_context_menu(owner, include_actions=True)
    # 先让托盘指向新菜单，再销毁旧菜单；旧菜单挂在 owner 上不销毁会随每次角色切换累积
    owner.tray.setContextMenu(new_menu)
    _replace_context_menu(owner, new_menu)
    owner.tray.show()


def build_menu(owner, include_actions=False):
    new_menu = build_pet_context_menu(owner, include_actions=include_actions)
    _replace_context_menu(owner, new_menu)
    return new_menu


def _replace_context_menu(owner, new_menu):
    old_menu = owner.context_menu
    owner.context_menu = new_menu
    if old_menu is not None and old_menu is not new_menu:
        old_menu.deleteLater()


def hide_tray(owner):
    if owner.tray:
        owner.tray.hide()
