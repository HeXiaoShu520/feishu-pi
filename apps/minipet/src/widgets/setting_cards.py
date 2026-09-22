# coding:utf-8
"""设置页通用 SettingCard 组件。

qfluentwidgets 的 SettingCard 只提供基础骨架，
这里在其基础上扩展了滑块、下拉框、文本输入和头像选择四种变体，
供各设置页直接复用，避免重复布局代码。
"""

from pathlib import Path
import shutil

from PySide6.QtCore import Qt
from PySide6.QtGui import QAction, QPixmap
from PySide6.QtWidgets import QApplication, QFileDialog, QLabel
from qfluentwidgets import ComboBox, FluentIcon as FIF, LineEdit, PrimaryPushButton, SettingCard, Slider, SpinBox

import config


class RangeSettingCard(SettingCard):
    """滑块数值卡片：右侧滑块 + 实时数值标签，业务值 = 滑块值 × factor。"""

    def __init__(self, minimum, maximum, factor, icon, title, content=None, parent=None):
        super().__init__(icon, title, content, parent)
        # factor 用于把 int 滑块值转换成业务单位（如 0.01 把 50-200 映射到 0.5-2.0 的缩放比例）
        self.factor = factor
        self.valueLabel = QLabel(self)
        self.slider = Slider(Qt.Horizontal, self)
        self.slider.setRange(minimum, maximum)
        self.slider.setMinimumWidth(260)
        self.hBoxLayout.addStretch(1)
        self.hBoxLayout.addWidget(self.valueLabel, 0, Qt.AlignRight)
        self.hBoxLayout.addSpacing(12)
        self.hBoxLayout.addWidget(self.slider, 0, Qt.AlignRight)
        self.hBoxLayout.addSpacing(16)
        self.slider.valueChanged.connect(self._on_value_changed)

    def _on_value_changed(self, value):
        self.valueLabel.setText('%g' % (value * self.factor))
        self.valueLabel.adjustSize()

    def setValue(self, value):
        self.slider.setValue(value)
        self._on_value_changed(value)

    def value(self):
        return self.slider.value() * self.factor


class SpinBoxSettingCard(SettingCard):
    """整数数字输入卡片：带步进按钮的输入框，适合分钟数等有量纲的整数。"""

    def __init__(self, minimum, maximum, icon, title, content=None, suffix='', parent=None):
        super().__init__(icon, title, content, parent)
        self.spinBox = SpinBox(self)
        self.spinBox.setRange(minimum, maximum)
        self.spinBox.setMinimumWidth(160)
        if suffix:
            self.spinBox.setSuffix(suffix)
        self.hBoxLayout.addStretch(1)
        self.hBoxLayout.addWidget(self.spinBox, 0, Qt.AlignRight)
        self.hBoxLayout.addSpacing(16)

    def setValue(self, value):
        self.spinBox.setValue(int(value))

    def value(self):
        return self.spinBox.value()


class ComboSettingCard(SettingCard):
    """下拉框卡片：items 支持 (value, text)、(value, text, icon) 或纯字符串三种形式。"""

    def __init__(self, items, icon, title, content=None, parent=None):
        super().__init__(icon, title, content, parent)
        self.comboBox = ComboBox(self)
        self.comboBox.setMinimumWidth(180)
        # 维护双向映射，以便通过内部值或显示文本互相查找
        self.valueToText = {}
        self.textToValue = {}
        for item in items:
            icon = None
            if isinstance(item, tuple) and len(item) >= 3:
                value, text, icon = item[:3]
            elif isinstance(item, tuple):
                value, text = item
            else:
                value, text = item, item
            self.valueToText[value] = text
            self.textToValue[text] = value
            self.comboBox.addItem(text, icon=icon, userData=value)
        self.hBoxLayout.addStretch(1)
        self.hBoxLayout.addWidget(self.comboBox, 0, Qt.AlignRight)
        self.hBoxLayout.addSpacing(16)

    def setCurrentText(self, text):
        index = self.comboBox.findText(text)
        if index >= 0:
            self.comboBox.setCurrentIndex(index)

    def setCurrentValue(self, value):
        text = self.valueToText.get(value, value)
        self.setCurrentText(text)

    def currentText(self):
        return self.comboBox.currentText()

    def currentValue(self):
        return self.comboBox.currentData() or self.textToValue.get(self.comboBox.currentText(), self.comboBox.currentText())


class LineEditSettingCard(SettingCard):
    """文本输入卡片：password=True 时附带明文/掩码切换按钮。"""

    def __init__(self, icon, title, content=None, password=False, placeholder='', parent=None):
        super().__init__(icon, title, content, parent)
        self.lineEdit = LineEdit(self)
        self.lineEdit.setMinimumWidth(300)
        self.lineEdit.setClearButtonEnabled(True)
        if placeholder:
            self.lineEdit.setPlaceholderText(placeholder)
        if password:
            self._setup_password_toggle()
        self.hBoxLayout.addStretch(1)
        self.hBoxLayout.addWidget(self.lineEdit, 0, Qt.AlignRight)
        self.hBoxLayout.addSpacing(16)

    def _setup_password_toggle(self):
        """为密码输入框添加默认隐藏的明文切换动作。"""
        self._password_visible = False
        self._password_action = QAction(self.lineEdit)
        self._password_action.setIcon(FIF.VIEW.icon())
        self._password_action.setToolTip('显示明文')
        self._password_action.triggered.connect(self._toggle_password_visibility)
        self.lineEdit.addAction(self._password_action, LineEdit.TrailingPosition)
        self.lineEdit.setEchoMode(LineEdit.Password)

    def _toggle_password_visibility(self):
        """切换密码输入框的掩码和明文显示状态。"""
        self._password_visible = not self._password_visible
        self.lineEdit.setEchoMode(LineEdit.Normal if self._password_visible else LineEdit.Password)
        self._password_action.setIcon(FIF.HIDE.icon() if self._password_visible else FIF.VIEW.icon())
        self._password_action.setToolTip('隐藏明文' if self._password_visible else '显示明文')

    def text(self):
        return self.lineEdit.text().strip()

    def setText(self, value):
        self.lineEdit.setText(str(value))


class AvatarPathSettingCard(LineEditSettingCard):
    """头像选择卡片。

    设置页只保存头像文件名；用户从任意路径选择图片时，先复制到
    data/avatars，再把文件名写入配置。这样聊天窗口和回复卡片都能通过
    config.avatar_path() 稳定加载头像。
    """

    def __init__(self, icon, title, content=None, parent=None):
        super().__init__(icon, title, content, placeholder='选择 png / jpg / svg 图片', parent=parent)
        self._filename = ''
        self.lineEdit.hide()  # 路径输入框保留底层能力，但 UI 只展示文件名和预览。
        self.preview = QLabel(self)
        self.preview.setFixedSize(42, 42)
        self.preview.setAlignment(Qt.AlignCenter)
        self.preview.setStyleSheet('QLabel{border:1px solid #dcdfe6;border-radius:8px;background:#fff;}')
        self.name_label = QLabel('未选择', self)
        self.name_label.setStyleSheet('QLabel{color:#909399;font-size:13px;}')
        self.button = PrimaryPushButton('选择', self)
        self.hBoxLayout.insertWidget(self.hBoxLayout.count() - 1, self.name_label, 0, Qt.AlignRight)
        self.hBoxLayout.insertWidget(self.hBoxLayout.count() - 1, self.preview, 0, Qt.AlignRight)
        self.hBoxLayout.insertWidget(self.hBoxLayout.count() - 1, self.button, 0, Qt.AlignRight)
        self.button.clicked.connect(self._choose_file)
        self._update_preview()

    def text(self):
        return self._filename

    def setText(self, value):
        self._filename = str(value or '').strip()
        self._update_preview()

    def _copy_to_avatar_dir(self, path):
        """复制外部头像到 data/avatars，并返回应保存到配置里的文件名。"""
        source = Path(path)
        if not source.is_file():
            return str(path or '').strip()
        config.AVATARS_DIR.mkdir(parents=True, exist_ok=True)
        dest = config.AVATARS_DIR / source.name
        if source.resolve() != dest.resolve():
            shutil.copy2(source, dest)
        return dest.name

    def _choose_file(self):
        path, _ = QFileDialog.getOpenFileName(
            self.window(),
            '选择头像',
            str(config.DATA_DIR),
            '图片文件 (*.png *.jpg *.jpeg *.bmp *.svg);;所有文件 (*)',
        )
        if path:
            self.setText(self._copy_to_avatar_dir(path))

    def _update_preview(self):
        filename = self._filename
        if filename:
            path = config.AVATARS_DIR / filename
            if not path.is_file():
                # 兼容旧配置里保存绝对路径的情况：发现文件存在就迁移到 avatars 目录。
                migrated_name = self._copy_to_avatar_dir(filename)
                if migrated_name != filename:
                    self._filename = migrated_name
                    path = config.AVATARS_DIR / migrated_name
            pixmap = QPixmap(str(path)) if path.is_file() else QPixmap()
        else:
            pixmap = QPixmap()
        if pixmap.isNull():
            self.preview.setPixmap(QPixmap())
            self.preview.setText('?')
            self.name_label.setText('未选择')
            return
        self.preview.setText('')
        screen = QApplication.primaryScreen()
        dpr = screen.devicePixelRatio() if screen else 1.0
        pm = pixmap.scaled(int(38 * dpr), int(38 * dpr), Qt.KeepAspectRatio, Qt.SmoothTransformation)
        pm.setDevicePixelRatio(dpr)
        self.preview.setPixmap(pm)
        self.name_label.setText(self._filename)



