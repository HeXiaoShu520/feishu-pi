# coding:utf-8
"""
MiniPet 设置页面基类，单独放置以避免循环导入。
"""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QLabel, QWidget
from qfluentwidgets import ExpandLayout, PrimaryPushButton, ScrollArea
from qfluentwidgets import FluentIcon as FIF

import config


class MiniPetScrollPage(ScrollArea):
    def __init__(self, title, parent=None, save_callback=None):
        super().__init__(parent=parent)
        self.scrollWidget = QWidget()
        self.expandLayout = ExpandLayout(self.scrollWidget)
        self.settingLabel = QLabel(title, self)
        self.saveButton = None
        if save_callback:
            self.saveButton = PrimaryPushButton('保存', self)
            self.saveButton.setIcon(FIF.SAVE)
            self.saveButton.clicked.connect(save_callback)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.setViewportMargins(0, 64, 0, 12)
        self.setWidget(self.scrollWidget)
        self.setWidgetResizable(True)
        self.scrollWidget.setObjectName('scrollWidget')
        self.settingLabel.setObjectName('settingLabel')
        self.expandLayout.setSpacing(26)
        self.expandLayout.setContentsMargins(60, 10, 60, 0)
        self._set_qss()

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self.settingLabel.move(50, 12)
        if self.saveButton:
            self.saveButton.move(self.width() - self.saveButton.width() - 60, 14)

    def _set_qss(self):
        qss = config.RES_DIR / 'icons' / 'system' / 'qss' / 'light' / 'setting_interface.qss'
        if qss.is_file():
            self.setStyleSheet(qss.read_text(encoding='utf-8'))
