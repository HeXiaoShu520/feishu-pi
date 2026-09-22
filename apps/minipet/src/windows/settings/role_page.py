# coding:utf-8
"""桌宠外观设置页面。"""

from PySide6.QtCore import QSize, Qt, Signal
from PySide6.QtGui import QIcon, QPixmap
from PySide6.QtWidgets import QApplication, QLabel
from qfluentwidgets import InfoBar, InfoBarPosition, SettingCardGroup
from qfluentwidgets import FluentIcon as FIF

import config
from base_page import MiniPetScrollPage
from widgets.setting_cards import AvatarPathSettingCard, ComboSettingCard, LineEditSettingCard, RangeSettingCard, SpinBoxSettingCard


def _icon(name):
    """加载 icons/system 目录下的内置图标。"""
    return QIcon(str(config.RES_DIR / 'icons' / 'system' / name))


class RolePage(MiniPetScrollPage):
    """角色设定页：维护用户头像、宠物外观、名字和尺寸。"""

    settings_changed = Signal()
    pet_changed = Signal(str)

    def __init__(self, parent=None):
        """读取当前配置并搭建"我的设置"和"宠物设置"两个分组。"""
        super().__init__('角色设定', parent, save_callback=lambda: self._save())
        self.userGroup = SettingCardGroup('我的设置', self.scrollWidget)
        self.userAvatarCard = AvatarPathSettingCard(FIF.PEOPLE, '我的头像', '聊天窗口中用户消息显示的头像', self.userGroup)
        self.userAvatarCard.setText(config.app_config.get('user_avatar', ''))

        self.petGroup = SettingCardGroup('宠物设置', self.scrollWidget)
        self.petCard = ComboSettingCard(self._pet_model_items(), _icon('homestar.svg'), '宠物形象', '应用启动时加载的角色资源', self.petGroup)
        self.petCard.comboBox.setMinimumWidth(260)
        self.petCard.comboBox.setIconSize(QSize(28, 28))
        self.petCard.setCurrentText(config.app_config.get('default_pet', ''))
        self.petAutoSwitchCard = SpinBoxSettingCard(0, 10080, _icon('homestar.svg'), '形象自动切换(分钟)', '每 N 分钟随机切换到另一个宠物形象，0 表示不开启', suffix=' 分钟', parent=self.petGroup)
        self.petAutoSwitchCard.setValue(int(config.app_config.get('pet_auto_switch_minutes', 0) or 0))
        self.petPreview = QLabel(self.petCard)
        self.petPreview.setFixedSize(42, 42)
        self.petPreview.setAlignment(Qt.AlignCenter)
        self.petPreview.setStyleSheet('QLabel{border:1px solid #dcdfe6;border-radius:8px;background:#fff;}')
        self.petCard.hBoxLayout.insertWidget(self.petCard.hBoxLayout.count() - 1, self.petPreview, 0, Qt.AlignRight)
        self.petCard.comboBox.currentTextChanged.connect(self._update_pet_preview)
        self._update_pet_preview()
        self.petNameCard = LineEditSettingCard(_icon('character.svg'), '宠物名字', '回复卡片、聊天窗口和语音通话中显示的名字', placeholder='例如：小呆', parent=self.petGroup)
        self.petNameCard.setText(config.app_config.get('pet_name') or config.current_pet or '')
        self.petAvatarCard = AvatarPathSettingCard(_icon('character.svg'), '宠物头像', '聊天和语音聊天中显示的宠物头像', self.petGroup)
        self.petAvatarCard.setText(config.app_config.get('pet_avatar', ''))

        self.userGroup.addSettingCard(self.userAvatarCard)
        self.petGroup.addSettingCard(self.petNameCard)
        self.petGroup.addSettingCard(self.petAvatarCard)
        self.petGroup.addSettingCard(self.petCard)
        self.petGroup.addSettingCard(self.petAutoSwitchCard)
        self.scaleCard = RangeSettingCard(50, 200, 0.01, _icon('homestar.svg'), '宠物大小', '宠物窗口的缩放比例，重启后生效', self.petGroup)
        self.scaleCard.setValue(round(float(config.app_config.get('scale', 1.0)) * 100))
        self.petGroup.addSettingCard(self.scaleCard)
        self.expandLayout.addWidget(self.userGroup)
        self.expandLayout.addWidget(self.petGroup)

    def _pet_model_items(self):
        """生成带模型预览图标的下拉选项列表。"""
        return [(pet, pet, QIcon(str(config.pet_model_image_path(pet)))) for pet in config.get_pet_list()]

    def sync_from_config(self):
        """把宠物模型下拉同步为当前实际加载的模型。

        自动轮换等外部改动会更新 default_pet 但不经过本页；每次打开
        设置窗口时调用，避免显示过期快照。
        """
        saved = config.app_config.get('default_pet', '') or ''
        if self.petCard.currentText() != saved:
            self.petCard.setCurrentText(saved)

    def _update_pet_preview(self):
        """在宠物模型卡片右侧刷新 42px 预览图，加载失败显示问号。"""
        path = config.pet_model_image_path(self.petCard.currentText())
        pixmap = QPixmap(str(path))
        if pixmap.isNull():
            self.petPreview.setPixmap(QPixmap())
            self.petPreview.setText('?')
            return
        self.petPreview.setText('')
        screen = QApplication.primaryScreen()
        dpr = screen.devicePixelRatio() if screen else 1.0
        pm = pixmap.scaled(int(38 * dpr), int(38 * dpr), Qt.KeepAspectRatio, Qt.SmoothTransformation)
        pm.setDevicePixelRatio(dpr)
        self.petPreview.setPixmap(pm)

    def _save(self):
        """保存角色配置；宠物模型变更时发 pet_changed 通知主程序热重载。"""
        old_pet = config.app_config.get('default_pet')
        new_pet = self.petCard.currentText()
        config.app_config.update({
            'default_pet': new_pet,
            'pet_name': self.petNameCard.text(),
            'pet_avatar': self.petAvatarCard.text(),
            'user_avatar': self.userAvatarCard.text(),
            'scale': round(float(self.scaleCard.value()), 2),
            'pet_auto_switch_minutes': int(self.petAutoSwitchCard.value()),
        })
        config.save_app_config()
        InfoBar.success('保存成功', '角色设置已保存', duration=2000, position=InfoBarPosition.BOTTOM, parent=self.window())
        self.settings_changed.emit()
        # 只有模型确实切换时才发信号，避免每次保存都触发主程序重载资源
        if old_pet != new_pet:
            self.pet_changed.emit(new_pet)
