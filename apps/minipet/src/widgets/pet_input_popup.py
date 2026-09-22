# coding:utf-8
"""
桌宠快速输入弹窗。

从 desktop_pet.py 拆出，专门负责双击桌宠后的输入体验：文本输入、图片附件、
提交后的思考动画。业务提交结果通过 submitted 信号交给 DesktopPet/MiniPetApp。
"""

import time
from tempfile import NamedTemporaryFile

from PySide6.QtCore import QByteArray, QBuffer, QIODevice, QEasingCurve, QEvent, QParallelAnimationGroup, QPropertyAnimation, QPoint, Qt, QUrl, Signal
from PySide6.QtGui import QDesktopServices, QKeyEvent, QPixmap
from PySide6.QtWidgets import QApplication, QFrame, QHBoxLayout, QLabel, QLineEdit, QPushButton, QVBoxLayout, QWidget

from widgets.ui_utils import clamp_popup_pos
import theme as _theme


class ImageAttachmentChip(QFrame):
    """快速输入弹窗中的图片附件缩略条。"""

    remove_requested = Signal(str)  # 点击 × 时发出，参数为附件 key

    def __init__(self, key, image, parent=None):
        """构建 18px 缩略图 + 文件名 + 关闭按钮的单行附件条。"""
        super().__init__(parent)
        self.key = key
        self.image = image
        self.temp_path = None
        self.setObjectName('ImageAttachmentChip')
        self.setFixedHeight(28)
        self.setStyleSheet('''
            QFrame#ImageAttachmentChip { border: 1px solid rgba(210,216,226,245); border-radius: 8px; background: rgba(255,255,255,245); }
            QLabel { border: none; background: transparent; color: #3a4054; font-family: "Microsoft YaHei UI", "Microsoft YaHei"; font-size: 12px; }
            QPushButton { border: none; border-radius: 7px; background: transparent; color: #7b8496; font-weight: 700; }
            QPushButton:hover { background: #eef6ff; color: #d93026; }
        ''')
        row = QHBoxLayout(self)
        row.setContentsMargins(6, 3, 6, 3)
        row.setSpacing(5)
        thumb = QLabel(self)
        thumb.setFixedSize(18, 18)
        thumb.setStyleSheet('QLabel{border:1px solid rgba(210,216,226,230);border-radius:4px;background:white;}')
        thumb.setPixmap(QPixmap.fromImage(image).scaled(18, 18, Qt.KeepAspectRatioByExpanding, Qt.SmoothTransformation))
        name = QLabel('image.png', self)
        close_btn = QPushButton('×', self)
        close_btn.setFixedSize(16, 16)
        close_btn.clicked.connect(lambda: self.remove_requested.emit(self.key))
        row.addWidget(thumb)
        row.addWidget(name)
        row.addWidget(close_btn)

    def mouseDoubleClickEvent(self, event):
        # 双击缩略图用系统默认程序预览图片；临时文件在进程生命周期内保留，
        # 不删除是因为外部程序可能异步打开，过早删除会导致"文件不存在"错误
        if event.button() == Qt.LeftButton:
            if self.temp_path is None:
                tmp = NamedTemporaryFile(delete=False, suffix='.png')
                tmp.close()
                self.image.save(tmp.name, 'PNG')
                self.temp_path = tmp.name
            QDesktopServices.openUrl(QUrl.fromLocalFile(self.temp_path))
            event.accept()
            return
        super().mouseDoubleClickEvent(event)


class PetInputPopup(QFrame):
    """桌宠双击后显示的快速输入弹窗。"""

    submitted = Signal(object)  # 提交内容：纯文本 str 或 文本+图片 blocks list

    def __init__(self, x, y, parent=None):
        """构建输入卡片并定位到锚点 (x, y) 上方 18px 处，带滑入淡入动画。"""
        super().__init__(parent)
        self.anim_group = None
        self._owner = parent
        self.anchor_x = x
        self.anchor_y = y
        self.pending_images = []
        self.pending_image_keys = set()
        self.attachment_chips = {}
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool | Qt.NoDropShadowWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setWindowOpacity(0.0)
        t = _theme.current_theme()
        self.setStyleSheet('''
            QFrame#InputCard {
                border: 1px solid %(border)s;
                border-radius: 17px;
                background: %(bg)s;
            }
            QLabel#InputDot {
                border: none;
                border-radius: 5px;
                background: %(dot)s;
            }
            QLineEdit {
                border: none;
                border-radius: 0;
                padding: 0;
                background: transparent;
                color: %(text)s;
                font-family: "Microsoft YaHei UI", "Microsoft YaHei";
                font-size: 13px;
                selection-background-color: #dbeeff;
            }
            QLineEdit:focus { background: transparent; }
            QLineEdit::placeholder { color: #8b93a7; }
        ''' % {
            'bg': t['input_card_bg'],
            'border': t['input_card_border'],
            'dot': t['input_dot'],
            'text': t['input_text'],
        })
        self.card = QFrame(self)
        self.card.setObjectName('InputCard')
        self.card.setMinimumHeight(38)
        root = QVBoxLayout(self.card)
        root.setContentsMargins(14, 7, 14, 7)
        root.setSpacing(6)
        self.attachment_holder = QWidget(self.card)
        self.attachment_row = QHBoxLayout(self.attachment_holder)
        self.attachment_row.setContentsMargins(0, 0, 0, 0)
        self.attachment_row.setSpacing(6)
        self.attachment_holder.hide()
        root.addWidget(self.attachment_holder)
        input_row = QHBoxLayout()
        input_row.setContentsMargins(0, 0, 0, 0)
        input_row.setSpacing(7)
        dot = QLabel(self.card)
        dot.setObjectName('InputDot')
        dot.setFixedSize(10, 10)
        input_row.addWidget(dot, 0, Qt.AlignVCenter)
        self.input = QLineEdit(self.card)
        self.input.setAcceptDrops(True)
        self.input.installEventFilter(self)
        self.input.setPlaceholderText('想对宠物说什么？')
        self.input.setAlignment(Qt.AlignVCenter | Qt.AlignLeft)
        self.input.setFixedHeight(24)
        self.input.returnPressed.connect(self._submit)
        input_row.addWidget(self.input, 1, Qt.AlignVCenter)
        root.addLayout(input_row)
        outer = QHBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(self.card)
        self.setFixedWidth(260)
        self.adjustSize()
        end_pos = clamp_popup_pos(QPoint(int(x - self.width() / 2), int(y - self.height() - 18)), self.size(), QPoint(int(x), int(y)))
        self.move(end_pos + QPoint(0, 12))
        self._animate_in(end_pos)

    def _animate_in(self, end_pos):
        """位置（180ms）和透明度（160ms）并行动画，从下方 12px 处滑入。"""
        self.show()
        self.raise_()
        self.activateWindow()
        self.input.setFocus()
        pos_anim = QPropertyAnimation(self, b'pos', self)
        pos_anim.setDuration(180)
        pos_anim.setStartValue(self.pos())
        pos_anim.setEndValue(end_pos)
        pos_anim.setEasingCurve(QEasingCurve.OutCubic)
        opacity_anim = QPropertyAnimation(self, b'windowOpacity', self)
        opacity_anim.setDuration(160)
        opacity_anim.setStartValue(0.0)
        opacity_anim.setEndValue(1.0)
        self.anim_group = QParallelAnimationGroup(self)
        self.anim_group.addAnimation(pos_anim)
        self.anim_group.addAnimation(opacity_anim)
        self.anim_group.start()

    def _image_to_data_url(self, image):
        # 快速输入弹窗用 JPEG 85 质量压缩，而非 PNG；
        # 原因：弹窗图片需要嵌入 prompt 发送，减小 base64 体积可降低 token 消耗
        data = QByteArray()
        buffer = QBuffer(data)
        buffer.open(QIODevice.WriteOnly)
        image.save(buffer, 'JPEG', 85)
        return 'data:image/jpeg;base64,' + bytes(data.toBase64()).decode('ascii')

    def _add_image(self, image):
        """添加图片附件：转 data URL 去重后入列表，并显示缩略条。"""
        # 用 data_url 本身作为去重 key，保证同一张图片不会被多次粘贴重复添加
        data_url = self._image_to_data_url(image)
        if data_url in self.pending_image_keys:
            return
        self.pending_image_keys.add(data_url)
        self.pending_images.append(data_url)
        chip = ImageAttachmentChip(data_url, image, self.card)
        chip.remove_requested.connect(self._remove_image)
        self.attachment_chips[data_url] = chip
        self.attachment_row.addWidget(chip)
        self.input.setPlaceholderText('可继续输入，回车发送')
        self._refresh_attachment_layout()

    def _remove_image(self, key):
        """移除指定图片附件及其缩略条，全部移完后恢复占位提示。"""
        chip = self.attachment_chips.pop(key, None)
        if chip is not None:
            self.attachment_row.removeWidget(chip)
            chip.deleteLater()
        self.pending_image_keys.discard(key)
        self.pending_images = [image for image in self.pending_images if image != key]
        if not self.pending_images:
            self.input.setPlaceholderText('想对宠物说什么？')
        self._refresh_attachment_layout()

    def _refresh_attachment_layout(self):
        """根据有无附件切换卡片高度（38/72）并重新定位到锚点上方。"""
        has_images = bool(self.pending_images)
        self.attachment_holder.setVisible(has_images)
        self.card.setFixedHeight(72 if has_images else 38)
        self.adjustSize()
        pos = clamp_popup_pos(QPoint(int(self.anchor_x - self.width() / 2), int(self.anchor_y - self.height() - 18)), self.size(), QPoint(int(self.anchor_x), int(self.anchor_y)))
        self.move(pos)
        self.card.update()
        self.update()

    def _build_content(self, text):
        # 纯文本时直接返回字符串，不包装成 blocks；
        # 只有混合图片时才构建 blocks list，保持下游处理的简洁性
        if not self.pending_images:
            return text
        blocks = []
        if text:
            blocks.append({'type': 'text', 'text': text})
        for image in self.pending_images:
            blocks.append({'type': 'image', 'src': image, 'alt': '图片'})
        return blocks

    def _submit(self):
        """回车提交：文本和图片都为空时忽略，否则发信号并关闭弹窗。"""
        text = self.input.text().strip()
        if text or self.pending_images:
            self.submitted.emit(self._build_content(text))
            self.close()

    def eventFilter(self, obj, event):
        if obj is self.input and event.type() == QEvent.MouseButtonPress and event.button() == Qt.RightButton:
            # 快捷输入可见时，右键只负责关闭；重开抑制统一由 closeEvent 处理。
            self.close()
            return True
        if obj is self.input and event.type() == QEvent.KeyPress and event.key() == Qt.Key_V and event.modifiers() & Qt.ControlModifier:
            # 拦截 Ctrl+V：优先尝试粘贴剪贴板图片；无图片时回退到默认文本粘贴行为，
            # 这样用户不需要区分文本和图片，统一用 Ctrl+V 操作
            image = QApplication.clipboard().image()
            if not image.isNull():
                self._add_image(image)
                return True
        return super().eventFilter(obj, event)

    def dragEnterEvent(self, event):
        """仅接受图片或本地文件 URL 的拖入。"""
        if event.mimeData().hasImage() or event.mimeData().hasUrls():
            event.acceptProposedAction()
            return
        super().dragEnterEvent(event)

    def dropEvent(self, event):
        """处理拖放：直接图片数据优先，否则逐个加载本地文件路径。"""
        mime = event.mimeData()
        if mime.hasImage():
            self._add_image(mime.imageData())
            event.acceptProposedAction()
            return
        for url in mime.urls():
            pixmap = QPixmap(url.toLocalFile())
            if not pixmap.isNull():
                self._add_image(pixmap.toImage())
                event.acceptProposedAction()
                return
        super().dropEvent(event)

    def mousePressEvent(self, event):
        if event.button() == Qt.RightButton:
            # 快捷输入可见时，右键只负责关闭；重开抑制统一由 closeEvent 处理。
            self.close()
            event.accept()
            return
        super().mousePressEvent(event)

    def changeEvent(self, event):
        """失焦自动关闭，保持桌面整洁。"""
        if event.type() == QEvent.ActivationChange and not self.isActiveWindow():
            self.close()
        super().changeEvent(event)

    def closeEvent(self, event):
        if self._owner is not None:
            # 任意浮层关闭后，短时间内不允许快捷菜单重新打开，避免同一次点击关闭后又弹出。
            self._owner.block_quick_menu_until = time.monotonic() + 0.4
        super().closeEvent(event)

    def keyPressEvent(self, event: QKeyEvent):
        if event.key() == Qt.Key_Escape:
            self.close()
            event.accept()
            return
        super().keyPressEvent(event)
