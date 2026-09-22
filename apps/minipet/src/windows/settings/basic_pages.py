# coding:utf-8
"""基础设置页面。"""

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QLabel
from qfluentwidgets import InfoBar, InfoBarPosition, SettingCardGroup, SwitchSettingCard
from qfluentwidgets import FluentIcon as FIF

import config
from auto_start import set_enabled
from base_page import MiniPetScrollPage
from widgets.setting_cards import ComboSettingCard, RangeSettingCard
from theme import THEME_OPTIONS, THEMES, DEFAULT_THEME


STYLE_PREVIEW_QSS = {
    name: data['preview_qss']
    for name, data in THEMES.items()
}

VOICE_FOLLOW_EFFECT_OPTIONS = [
    ('spring', '弹力绳'),
    ('magnet', '丝滑吸附'),
]


def _attach_style_preview(card):
    """在主题下拉卡片右侧显示一个小型实时预览。"""
    preview = QLabel(card)
    preview.setFixedSize(92, 32)
    preview.setAlignment(Qt.AlignCenter)
    preview.setToolTip('当前样式预览')

    def update_preview(value=None):
        value = value or card.currentValue()
        qss = STYLE_PREVIEW_QSS.get(value, '')
        theme_data = THEMES.get(value, THEMES[DEFAULT_THEME])
        color = '#f4f6fb' if theme_data['card']['dark'] else '#263238'
        text = theme_data.get('_label', value)
        preview.setText(text)
        preview.setStyleSheet(
            'QLabel{%s color:%s; font:12px "Microsoft YaHei UI"; font-weight:600;}'
            % (qss, color)
        )

    update_preview()
    card.comboBox.currentIndexChanged.connect(lambda _index: update_preview())
    card.hBoxLayout.insertWidget(card.hBoxLayout.count() - 2, preview, 0, Qt.AlignRight)
    return preview


class BasicPage(MiniPetScrollPage):
    """外观、打印字效果等与 Agent 内核无关的基础设置页。"""

    settings_changed = Signal()

    def __init__(self, parent=None):
        super().__init__('基础设置', parent, save_callback=lambda: self._save())
        typewriter_cfg = config.typewriter_config
        typewriter_defaults = config.DEFAULT_TYPEWRITER_CONFIG

        self.visualGroup = SettingCardGroup('视觉样式', self.scrollWidget)
        self.appThemeCard = ComboSettingCard(
            THEME_OPTIONS, FIF.PALETTE, '整体风格',
            '统一设置回复卡片、语音球、快捷输入框、菜单、聊天窗口等的视觉风格',
            self.visualGroup,
        )
        self.appThemeCard.setCurrentValue(config.app_config.get('app_theme', DEFAULT_THEME))
        _attach_style_preview(self.appThemeCard)
        self.voiceFollowEffectCard = ComboSettingCard(
            VOICE_FOLLOW_EFFECT_OPTIONS, FIF.SPEED_HIGH, '语音球跟随效果',
            '弹力绳有惯性过冲；丝滑吸附更稳、更少跳变', self.visualGroup,
        )
        self.voiceFollowEffectCard.setCurrentValue(config.app_config.get('voice_follow_effect', 'spring'))
        self.volumeCard = RangeSettingCard(
            0, 100, 0.01, FIF.VOLUME, '声音大小',
            '影响语音播报和语音聊天的音量', self.visualGroup,
        )
        self.volumeCard.setValue(round(float(config.app_config.get('volume', 0.9)) * 100))
        self.autoStartCard = SwitchSettingCard(
            FIF.SETTING, '开机自启', '系统启动时自动运行 MiniPet', parent=self.visualGroup,
        )
        self.autoStartCard.setChecked(bool(config.app_config.get('auto_start', False)))

        self.replyDisplayGroup = SettingCardGroup('回复设置', self.scrollWidget)
        self.typewriterEnabledCard = SwitchSettingCard(
            FIF.MESSAGE, '打印字效果', '开启后，回复文字会一字一字显示；关闭后直接显示完整回复',
            parent=self.replyDisplayGroup,
        )
        self.typewriterEnabledCard.setChecked(bool(typewriter_cfg.get('enabled', typewriter_defaults['enabled'])))
        self.typewriterSpeedCard = RangeSettingCard(
            8, 120, 1, FIF.MESSAGE, '打印字速度',
            '每个字的最大显示间隔，单位毫秒，数值越小越快', self.replyDisplayGroup,
        )
        self.typewriterSpeedCard.setValue(int(typewriter_cfg.get('speed_ms', typewriter_defaults['speed_ms'])))
        self.typewriterMaxDurationCard = RangeSettingCard(
            500, 15000, 1, FIF.FONT_SIZE, '最长显示时长',
            '单条回复打印字效果的最长时间，单位毫秒', self.replyDisplayGroup,
        )
        self.typewriterMaxDurationCard.setValue(int(typewriter_cfg.get('max_duration_ms', typewriter_defaults['max_duration_ms'])))
        self.typewriterTtsDelayCard = RangeSettingCard(
            0, 3000, 1, FIF.VOLUME, '语音播报文字延迟',
            '开启语音播报时，回复文字延迟显示的时间，单位毫秒', self.replyDisplayGroup,
        )
        self.typewriterTtsDelayCard.setValue(int(typewriter_cfg.get('tts_delay_ms', typewriter_defaults['tts_delay_ms'])))

        for card in (self.appThemeCard, self.voiceFollowEffectCard, self.volumeCard, self.autoStartCard):
            self.visualGroup.addSettingCard(card)
        for card in (self.typewriterEnabledCard, self.typewriterSpeedCard,
                     self.typewriterMaxDurationCard, self.typewriterTtsDelayCard):
            self.replyDisplayGroup.addSettingCard(card)
        self.expandLayout.addWidget(self.visualGroup)
        self.expandLayout.addWidget(self.replyDisplayGroup)

    def _save(self):
        config.app_config.update({
            'app_theme': self.appThemeCard.currentValue() or DEFAULT_THEME,
            'voice_follow_effect': self.voiceFollowEffectCard.currentValue() or 'spring',
            'volume': round(float(self.volumeCard.value()), 2),
            'auto_start': self.autoStartCard.isChecked(),
        })
        config.app_config.pop('voice_follow_level', None)
        config.save_app_config()
        try:
            set_enabled(self.autoStartCard.isChecked())
        except Exception as exc:
            InfoBar.warning(
                '开机自启设置失败', str(exc)[:80], duration=3000,
                position=InfoBarPosition.BOTTOM, parent=self.window(),
            )
        config.save_typewriter_config({
            'enabled': self.typewriterEnabledCard.isChecked(),
            'speed_ms': int(self.typewriterSpeedCard.value()),
            'max_duration_ms': int(self.typewriterMaxDurationCard.value()),
            'tts_delay_ms': int(self.typewriterTtsDelayCard.value()),
        })
        InfoBar.success(
            '保存成功', '基础已保存', duration=2000,
            position=InfoBarPosition.BOTTOM, parent=self.window(),
        )
        self.settings_changed.emit()
