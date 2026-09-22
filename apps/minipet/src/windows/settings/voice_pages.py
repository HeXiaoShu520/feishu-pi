# coding:utf-8
"""语音设置页面。

包含三个独立子页：
- TTSPage：火山豆包 TTS 音色、API Key、最大字数等配置
- WakePage：本地唤醒词和连续对话开关
- DailyInputPage：鼠标中键语音输入法功能开关

三页共用同一份 TTS API Key（保存在 tts_config），互相解耦但数据来源统一。
"""

import hashlib

from PySide6.QtCore import Qt, QUrl, Signal
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import QHBoxLayout, QPlainTextEdit
from qfluentwidgets import HyperlinkButton, InfoBar, InfoBarPosition, PrimaryPushButton, PushSettingCard, SettingCard, SettingCardGroup, SwitchSettingCard
from qfluentwidgets import FluentIcon as FIF

import config
from base_page import MiniPetScrollPage
from clients.kws_client import write_keywords_file
from hotkey_trigger import hotkey_display
from clients.tts_client import TtsCacheWorker, TtsPreviewWorker, stop_tts
from widgets.setting_cards import ComboSettingCard, LineEditSettingCard


# VOICE_OPTIONS 列出所有可用的豆包 TTS 音色；value 是 API 中的音色 ID，label 是界面显示名
VOICE_OPTIONS = [
    ('zh_female_vv_uranus_bigtts', 'vivi 2.0'),
    ('zh_female_xiaohe_uranus_bigtts', '小何 2.0'),
    ('zh_male_m191_uranus_bigtts', '云舟 2.0'),
    ('zh_male_taocheng_uranus_bigtts', '小天 2.0'),
    ('saturn_zh_female_cancan_tob', '知性灿灿'),
    ('saturn_zh_female_qingyingduoduo_cs_tob', '轻盈朵朵 2.0'),
    ('saturn_zh_female_tiaopigongzhu_tob', '调皮公主'),
    ('saturn_zh_female_keainvsheng_tob', '可爱女生'),
    ('zh_female_zhixingnv_uranus_bigtts', '知性女声 2.0'),
    ('zh_female_qinqienv_uranus_bigtts', '亲切女声 2.0'),
    ('zh_female_lingling_uranus_bigtts', '玲玲姐姐 2.0'),
    ('zh_female_jiaochuannv_uranus_bigtts', '娇喘女声 2.0'),
    ('zh_female_kailangjiejie_uranus_bigtts', '开朗姐姐 2.0'),
    ('zh_female_roumeinvyou_uranus_bigtts', '柔美女友2.0'),
    ('zh_female_sophie_uranus_bigtts', '魅力苏菲2.0'),
    ('zh_female_mengyatou_uranus_bigtts', '萌丫头'),
    ('zh_female_yingtaowanzi_uranus_bigtts', '樱桃丸子2.0'),
    ('zh_female_sajiaoxuemei_uranus_bigtts', '撒娇学妹2.0'),
]
VOICE_VALUE_TO_LABEL = dict(VOICE_OPTIONS)
VOICE_LABEL_TO_VALUE = {label: value for value, label in VOICE_OPTIONS}

class TTSPage(MiniPetScrollPage):
    """TTS 设置页：豆包语音能力开关、音色、API Key 和试听。"""

    settings_changed = Signal()
    hotkey_captured = Signal(str)  # 录制线程 → 主线程：捕获到新的触发按键

    def __init__(self, parent=None):
        """搭建语音合成和语音输入小助手分组。"""
        super().__init__('语音设置', parent, save_callback=lambda: self._save())
        self.worker = None
        self.preview_worker = None
        self._initializing = True
        cfg = config.tts_config
        self.apiGroup = SettingCardGroup('火山豆包语音', self.scrollWidget)
        # 方案A：三个文字超链接
        self.serviceLink = HyperlinkButton('https://console.volcengine.com/speech/new/setting/activate?_vtm_=a106466.b106468.0_0.0_0.0.44_7656326907147814435&projectName=default.', '服务开通', self.apiGroup)
        self.experienceLink = HyperlinkButton('https://console.volcengine.com/speech/new/experience/tts?projectName=default', '在线体验', self.apiGroup)
        self.apiDocLink = HyperlinkButton('https://www.volcengine.com/docs/6561/2528925?lang=zh', 'API 教程', self.apiGroup)

        self.apiGroup.vBoxLayout.removeWidget(self.apiGroup.titleLabel)
        title_row = QHBoxLayout()
        title_row.setContentsMargins(0, 0, 0, 0)
        title_row.addWidget(self.apiGroup.titleLabel)
        title_row.addSpacing(12)
        title_row.addWidget(self.serviceLink)
        title_row.addWidget(self.experienceLink)
        title_row.addWidget(self.apiDocLink)
        title_row.addStretch(1)
        self.apiGroup.vBoxLayout.insertLayout(0, title_row)

        self.enabledCard = SwitchSettingCard(FIF.VOLUME, '是否开启语音功能', '开启后，将启用语音合成、语音识别、实时语音聊天功能', parent=self.apiGroup)
        self.enabledCard.setChecked(bool(cfg.get('enabled', False)))
        self.apiKeyCard = LineEditSettingCard(FIF.VPN, 'API Key', '密钥会保存在本地设置 JSON；从控制台 API Key 管理中获取', password=True, placeholder='火山引擎 API Key', parent=self.apiGroup)
        self.apiKeyCard.setText(cfg.get('api_key', ''))
        self.voiceCard = ComboSettingCard(VOICE_OPTIONS, FIF.PEOPLE, '日常交流音色', '影响开启语音、结束语音和卡片回复语音，选择时会有音色预览', self.apiGroup)
        self.voiceCard.setCurrentValue(cfg.get('voice_name', config.DEFAULT_TTS_CONFIG['voice_name']))
        self.voiceCard.comboBox.currentTextChanged.connect(self._preview_voice)
        self.maxCharsCard = LineEditSettingCard(FIF.FONT_SIZE, '最大字数', '每次回复最大转换成音频的字数', placeholder='200', parent=self.apiGroup)
        self.maxCharsCard.lineEdit.setFixedWidth(120)
        self.maxCharsCard.setText(cfg.get('max_chars', config.DEFAULT_TTS_CONFIG['max_chars']))
        self.testTextCard = SettingCard(FIF.EDIT, '测试文本', '留空使用默认文案，生成', self.apiGroup)
        self.testTextEdit = QPlainTextEdit(self.testTextCard)
        self.testTextEdit.setPlaceholderText('你好呀，我是xx，有什么需要帮助的吗')
        self.testTextEdit.setPlainText(cfg.get('test_text', ''))
        self._style_editor(self.testTextEdit)
        self.testBtn = PrimaryPushButton('测试语音', self.testTextCard)
        self.testTextCard.hBoxLayout.addStretch(1)
        self.testTextCard.hBoxLayout.addWidget(self.testTextEdit, 0, Qt.AlignRight)
        self.testTextCard.hBoxLayout.addSpacing(8)
        self.testTextCard.hBoxLayout.addWidget(self.testBtn, 0, Qt.AlignRight)
        self.testTextCard.hBoxLayout.addSpacing(16)
        self.testBtn.clicked.connect(self._test)

        for card in [self.enabledCard, self.apiKeyCard, self.voiceCard, self.maxCharsCard, self.testTextCard]:
            self.apiGroup.addSettingCard(card)
        self.expandLayout.addWidget(self.apiGroup)

        daily_cfg = config.daily_input_config
        self.dailyGroup = SettingCardGroup('语音输入小助手', self.scrollWidget)
        self.dailyEnabledCard = SwitchSettingCard(FIF.MICROPHONE, '模拟语音输入法功能', '按配置的触发键开始/停止录音，识别结果自动注入当前输入框', parent=self.dailyGroup)
        self.dailyEnabledCard.setChecked(bool(daily_cfg.get('enabled', False)))
        self.dailyGroup.addSettingCard(self.dailyEnabledCard)
        self._pending_hotkey = str(daily_cfg.get('hotkey') or 'mouse:middle')
        self._capturing = False
        self._cap_key_listener = None
        self._cap_mouse_listener = None
        self._hotkey_hint = ''
        self.hotkeyCard = PushSettingCard('录制新按键', FIF.EDIT, '触发快捷键', hotkey_display(self._pending_hotkey), self.dailyGroup)
        self.hotkeyCard.clicked.connect(self._start_hotkey_capture)
        self.hotkey_captured.connect(self._apply_captured_hotkey)
        self.dailyGroup.addSettingCard(self.hotkeyCard)
        self.dailyInjectCard = ComboSettingCard(
            [('typing', '模拟打字'), ('paste', '复制粘贴')],
            FIF.MICROPHONE, '注入方式',
            '识别结果的注入方式：复制粘贴零丢失（推荐）；模拟打字更接近真实键入',
            parent=self.dailyGroup)
        self.dailyInjectCard.setCurrentValue(daily_cfg.get('inject_mode') or 'paste')
        self.dailyGroup.addSettingCard(self.dailyInjectCard)
        self.expandLayout.addWidget(self.dailyGroup)
        self._initializing = False

    def _style_editor(self, editor):
        # 编辑器宽度按父窗口比例计算，适配不同 DPI
        try:
            parent_width = self.window().width() if self.window() else 1020
            editor_width = max(480, min(600, int(parent_width * 0.50)))
        except:
            editor_width = 520
        editor.setFixedSize(editor_width, 78)
        editor.setStyleSheet(
            'QPlainTextEdit{background:#ffffff;border:1px solid #dfe3e8;border-radius:8px;'
            'padding:8px 10px;font-size:14px;color:#1f2328;}'
            'QPlainTextEdit:focus{border:1px solid #8ab4f8;}'
        )

    def _voice_preview_path(self, voice_value, text=''):
        # 预览文件按音色+文本内容哈希命名，相同参数直接复用缓存，避免重复请求 API
        safe_name = ''.join(ch if ch.isalnum() or ch in ('-', '_') else '_' for ch in voice_value)
        text = (text or '').strip()
        if text:
            digest = hashlib.sha1(text.encode('utf-8')).hexdigest()[:12]
            safe_name = '%s_%s' % (safe_name, digest)
        return config.DATA_DIR / 'tts_preview' / (safe_name + '.wav')

    def _preview_text(self, voice_value):
        """返回试听文案：优先用户自定义文本，否则按音色名生成默认文案。"""
        custom_text = self.testTextEdit.toPlainText().strip()
        if custom_text:
            return custom_text
        voice_label = VOICE_VALUE_TO_LABEL.get(voice_value, voice_value)
        preview_name = voice_label.replace(' 2.0', '').replace('2.0', '').strip()
        return '你好呀，我是%s，有什么需要帮助的吗' % preview_name

    def _open_preview_dir(self):
        """打开试听音频缓存目录。"""
        path = config.DATA_DIR / 'tts_preview'
        path.mkdir(parents=True, exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(path)))

    def _preview_voice(self):
        """切换音色时自动试听；先打断进行中的预览再启动新任务。"""
        if self._initializing:
            return
        # 打断正在进行的预览，换新角色
        if self.preview_worker is not None:
            self.preview_worker.result_ready.disconnect(self._on_preview_result)
            stop_tts()
            self.preview_worker.wait(500)
            self.preview_worker = None
        voice_value = self.voiceCard.currentValue() or config.DEFAULT_TTS_CONFIG['voice_name']
        self.preview_worker = TtsPreviewWorker(self._voice_preview_path(voice_value), parent=self)
        self.preview_worker.result_ready.connect(self._on_preview_result)
        self.preview_worker.start()

    def _on_preview_result(self, success, text):
        """预览完成：清空 worker 引用，失败时提示错误。"""
        self.preview_worker = None
        if not success:
            InfoBar.error('试听失败', text[:120], duration=5000, position=InfoBarPosition.BOTTOM, parent=self.window())

    def _collect(self):
        """收集 TTS 页界面值为一份配置 dict；非法字数回退默认值。"""
        try:
            max_chars = max(1, int(self.maxCharsCard.text() or config.DEFAULT_TTS_CONFIG['max_chars']))
        except ValueError:
            max_chars = config.DEFAULT_TTS_CONFIG['max_chars']
        return {
            'enabled': self.enabledCard.isChecked(),
            'api_key': self.apiKeyCard.text(),
            'voice_name': self.voiceCard.currentValue() or config.DEFAULT_TTS_CONFIG['voice_name'],
            'max_chars': max_chars,
            'test_text': self.testTextEdit.toPlainText().strip(),
            'disable_emoji_filter': config.DEFAULT_TTS_CONFIG['disable_emoji_filter'],
            'max_length_to_filter_parenthesis': config.DEFAULT_TTS_CONFIG['max_length_to_filter_parenthesis'],
        }

    def _collect_daily_input(self):
        """收集语音输入小助手配置（开关 + 触发快捷键 + 注入方式）。"""
        return {
            'enabled': self.dailyEnabledCard.isChecked(),
            'inject_mode': self.dailyInjectCard.currentValue() or 'paste',
            'hotkey': self._pending_hotkey,
        }

    def _start_hotkey_capture(self):
        """进入录制状态：下一个按下的键盘按键/鼠标中键成为新的触发键。"""
        if self._capturing:
            return
        self._capturing = True
        self.hotkeyCard.setContent('请按下新的快捷键（Esc 取消）…')
        from pynput import keyboard, mouse
        self._cap_key_listener = keyboard.Listener(on_press=self._on_capture_key)
        self._cap_mouse_listener = mouse.Listener(on_click=self._on_capture_click)
        self._cap_key_listener.start()
        self._cap_mouse_listener.start()

    def _on_capture_key(self, key):
        from pynput import keyboard as kb
        if key == kb.Key.esc:
            self.hotkey_captured.emit('')  # 取消
            return
        from hotkey_trigger import normalize_key
        hotkey = normalize_key(key)
        if hotkey:
            self.hotkey_captured.emit(hotkey)

    def _on_capture_click(self, x, y, button, pressed):
        from hotkey_trigger import normalize_button
        if pressed:
            hotkey = normalize_button(button)
            if hotkey in ('mouse:middle', 'mouse:x1', 'mouse:x2'):
                self.hotkey_captured.emit(hotkey)

    def _apply_captured_hotkey(self, hotkey):
        """（监听线程经信号投递回主线程）录制结果落地。"""
        self._capturing = False
        for listener in (self._cap_key_listener, self._cap_mouse_listener):
            if listener is not None:
                listener.stop()
        self._cap_key_listener = None
        self._cap_mouse_listener = None
        if hotkey:
            self._pending_hotkey = hotkey
            from hotkey_trigger import hotkey_display
            self.hotkeyCard.setContent('当前触发：%s（保存后生效）' % hotkey_display(hotkey))

    def _stop_capture_listeners(self):
        for attr in ('_cap_key_listener', '_cap_mouse_listener'):
            listener = getattr(self, attr, None)
            if listener is not None:
                listener.stop()
                setattr(self, attr, None)

    def _save(self):
        """把 TTS 和语音输入两份配置统一写盘。"""
        config.save_tts_config(self._collect())
        config.save_daily_input_config(self._collect_daily_input())
        self.settings_changed.emit()
        InfoBar.success('保存成功', '语音配置已保存', duration=2000, position=InfoBarPosition.BOTTOM, parent=self.window())

    def _export_path(self, voice_value):
        """生成带时间戳的导出文件路径，便于保留每次测试的音频。"""
        import datetime
        safe_voice = ''.join(ch if ch.isalnum() or ch in ('-', '_') else '_' for ch in voice_value)
        ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        return config.DATA_DIR / 'tts_export' / ('%s_%s.wav' % (safe_voice, ts))

    def _test(self):
        """测试语音：按当前配置合成试听文本，自定义文本时额外导出文件。"""
        cfg = self._collect()
        if not cfg.get('api_key'):
            InfoBar.error('缺少 API Key', '请先填写 API Key', duration=3000, position=InfoBarPosition.BOTTOM, parent=self.window())
            return
        stop_tts()
        self.testBtn.setEnabled(False)
        self.testBtn.setText('播放中...')
        voice_value = cfg['voice_name']
        preview_text = self._preview_text(voice_value)
        custom_text = self.testTextEdit.toPlainText().strip()
        preview_path = self._voice_preview_path(voice_value, preview_text)
        export_path = self._export_path(voice_value) if custom_text else None
        self._test_export_path = export_path
        self.worker = TtsCacheWorker(preview_text, cfg, preview_path, export_path=export_path, parent=self)
        self.worker.result_ready.connect(self._on_test_result)
        self.worker.start()

    def _on_test_result(self, success, text):
        """恢复测试按钮并按结果提示保存位置或错误。"""
        self.testBtn.setEnabled(True)
        self.testBtn.setText('测试语音')
        if success:
            export_path = getattr(self, '_test_export_path', None)
            if export_path:
                InfoBar.success('测试成功', '已保存到 %s' % export_path, duration=5000, position=InfoBarPosition.BOTTOM, parent=self.window())
            else:
                InfoBar.success('测试成功', '语音已播放完成，文件保存在 data/tts_preview', duration=3000, position=InfoBarPosition.BOTTOM, parent=self.window())
        else:
            InfoBar.error('测试失败', text[:120], duration=5000, position=InfoBarPosition.BOTTOM, parent=self.window())


class WakePage(MiniPetScrollPage):
    """唤醒词设置页：本地 KWS 唤醒开关和连续对话开关。"""

    settings_changed = Signal()

    def __init__(self, parent=None):
        """读取唤醒词和连续对话配置。"""
        super().__init__('唤醒词', parent, save_callback=lambda: self._save())
        from qfluentwidgets import SwitchButton
        voice_chat_cfg = config.voice_chat_config
        voice_chat_defaults = config.DEFAULT_VOICE_CHAT_CONFIG
        wake_cfg = config.wake_word_config
        wake_defaults = config.DEFAULT_WAKE_WORD_CONFIG

        self.wakeGroup = SettingCardGroup('唤醒词设置', self.scrollWidget)
        self.wakeEnabledCard = SettingCard(FIF.MICROPHONE, '启用唤醒词', '打开语音球后使用本地神经网络关键词唤醒（sherpa-onnx）', self.wakeGroup)
        self.wakeSwitch = SwitchButton(self.wakeEnabledCard)
        self.wakeSwitch.setChecked(bool(wake_cfg.get('enabled', wake_defaults['enabled'])))
        self.wakeEnabledCard.hBoxLayout.addStretch(1)
        self.wakeEnabledCard.hBoxLayout.addWidget(self.wakeSwitch, 0, Qt.AlignRight)
        self.wakeEnabledCard.hBoxLayout.addSpacing(16)

        self.wakeWordsCard = LineEditSettingCard(
            FIF.EDIT, '唤醒词',
            '支持多个词，用逗号分隔；保存后自动转换为唤醒模型配置',
            placeholder='例如：小月小月',
            parent=self.wakeGroup,
        )
        self.wakeWordsCard.lineEdit.setText(str(wake_cfg.get('words', wake_defaults['words'])))

        self.dialogGroup = SettingCardGroup('连续对话', self.scrollWidget)
        self.continuousVoiceCard = SwitchSettingCard(FIF.CHAT, '连续对话', '开启后每轮回复结束会自动进入下一次接听；关闭后则等待下一次唤醒', parent=self.dialogGroup)
        self.continuousVoiceCard.setChecked(bool(voice_chat_cfg.get('continuous', voice_chat_defaults['continuous'])))

        self.wakeGroup.addSettingCard(self.wakeEnabledCard)
        self.wakeGroup.addSettingCard(self.wakeWordsCard)
        self.wakeWeightCard = ComboSettingCard(
            [(3.5, '超灵敏'), (2.5, '灵敏'), (2.0, '普通'), (1.5, '精确')],
            FIF.MICROPHONE, '唤醒灵敏度',
            '精确：发音清晰才触发，几乎不误触；超灵敏：轻微相似即触发，误触最多。默认普通',
            parent=self.wakeGroup)
        self.wakeWeightCard.setCurrentValue(float(wake_cfg.get('weight', wake_defaults.get('weight', 2.0))))
        self.wakeGroup.addSettingCard(self.wakeWeightCard)
        self.dialogGroup.addSettingCard(self.continuousVoiceCard)
        self.expandLayout.addWidget(self.wakeGroup)
        self.expandLayout.addWidget(self.dialogGroup)

    def _collect_voice_chat(self):
        """收集连续对话开关。"""
        return {'continuous': self.continuousVoiceCard.isChecked()}

    def _collect_wake_word(self):
        """收集界面开关与唤醒词；唤醒词转换为模型配置并写入用户 keywords 文件。"""
        wake_cfg = config.wake_word_config
        collected = dict(wake_cfg)
        collected['enabled'] = self.wakeSwitch.isChecked()
        weight = float(self.wakeWeightCard.currentValue() or 2.0)
        words = self.wakeWordsCard.lineEdit.text().strip()
        keywords_path = config.ROOT_DIR / 'data' / 'wake_word_keywords.txt'
        try:
            write_keywords_file(keywords_path, words, weight=weight)
        except Exception as exc:
            return None, str(exc)
        collected['words'] = words
        collected['weight'] = weight
        collected['kws_keywords_path'] = 'data/wake_word_keywords.txt'
        return collected, None

    def _save(self):
        """保存唤醒词和连续对话配置并广播变更信号。"""
        collected, error = self._collect_wake_word()
        if collected is None:
            InfoBar.error('保存失败', (error or '唤醒词无效')[:120], duration=5000, position=InfoBarPosition.BOTTOM, parent=self.window())
            return
        config.save_voice_chat_config(self._collect_voice_chat())
        config.save_wake_word_config(collected)
        self.settings_changed.emit()
        InfoBar.success('保存成功', '唤醒词配置已保存，重新打开语音球后生效', duration=3000, position=InfoBarPosition.BOTTOM, parent=self.window())


class DailyInputPage(MiniPetScrollPage):
    """日常语音输入页：可配置触发快捷键的语音输入法独立开关。"""

    settings_changed = Signal()

    def __init__(self, parent=None):
        """读取开关状态并搭建说明分组。"""
        super().__init__('日常语音输入', parent, save_callback=lambda: self._save())
        cfg = config.daily_input_config

        self.mainGroup = SettingCardGroup('日常工作语音输入', self.scrollWidget)
        self.enabledCard = SwitchSettingCard(
            FIF.MICROPHONE,
            '启用鼠标中键语音输入',
            '开启后按鼠标中键开始/停止录音，识别结果自动打字到当前输入框',
            parent=self.mainGroup,
        )
        self.enabledCard.setChecked(bool(cfg.get('enabled', False)))

        self.noteCard = SettingCard(FIF.INFO, '使用说明', '依赖"语音设置"中配置的火山豆包 API Key', self.mainGroup)

        self.mainGroup.addSettingCard(self.enabledCard)
        self.mainGroup.addSettingCard(self.noteCard)
        self.expandLayout.addWidget(self.mainGroup)

    def _collect(self):
        """收集功能开关状态。"""
        return {'enabled': self.enabledCard.isChecked()}

    def _save(self):
        """保存日常语音输入配置并广播变更信号。"""
        config.save_daily_input_config(self._collect())
        self.settings_changed.emit()
        InfoBar.success('保存成功', '日常语音输入配置已保存', duration=2000, position=InfoBarPosition.BOTTOM, parent=self.window())
