# coding:utf-8
"""
文本聊天窗口。

聊天内容由 res/chat/chat.html 渲染，Python 侧负责收集输入、展示流式结果，
并通过 MiniPetApp 统一送入 mini-claw Agent 内核。
"""

import ctypes
import json
import sys
import uuid

if sys.platform == 'win32':
    from ctypes.wintypes import MSG, POINT

from PySide6.QtCore import QByteArray, QBuffer, QEvent, QIODevice, QSize, Qt, QUrl, Signal
from PySide6.QtGui import QColor, QFont, QGuiApplication, QIcon, QKeyEvent, QPainter, QPen, QPixmap
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import (QAbstractButton, QApplication, QFrame, QHBoxLayout, QLabel, QMenu, QPushButton, QSizePolicy, QVBoxLayout, QWidget)
from qfluentwidgets import TitleLabel, TransparentToolButton
from qfluentwidgets import FluentIcon as FIF

import config
from clients.stream_tts import StreamTtsQueue
from clients.tts_client import stop_tts
from windows.win32_frameless import WM_NCHITTEST, hit_test

try:
    from PySide6.QtTextEdit import QTextEdit
except ImportError:
    from PySide6.QtWidgets import QTextEdit


class ChatInput(QTextEdit):
    """支持回车发送、Shift+Enter 换行、粘贴/拖入图片的输入框。

    继承 QTextEdit 而非 QLineEdit，是因为需要支持多行输入和
    富文本粘贴拦截（将图片转成 data URL 而不是直接插入图片节点）。
    """

    image_pasted = Signal(str)

    def __init__(self, parent=None):
        """初始化输入框的基础交互属性和高度自适应监听。"""
        super().__init__(parent)
        self.setAcceptDrops(True)
        self.setAcceptRichText(False)
        self.setPlaceholderText('发送给宠物')
        self.setCursor(Qt.IBeamCursor)
        self.viewport().setCursor(Qt.IBeamCursor)
        self.setMinimumHeight(38)
        self.setMaximumHeight(120)
        self.document().setDocumentMargin(0)
        self.textChanged.connect(self._resize_to_content)
        self._resize_to_content()

    def _image_to_data_url(self, image):
        """把 QImage 编码成 PNG base64 data URL，方便直接嵌入消息 blocks。"""
        data = QByteArray()
        buffer = QBuffer(data)
        buffer.open(QIODevice.WriteOnly)
        image.save(buffer, 'PNG')
        return 'data:image/png;base64,' + bytes(data.toBase64()).decode('ascii')

    def createStandardContextMenu(self):
        """自建中文右键菜单，替代系统默认英文菜单。"""
        menu = QMenu(self)
        actions = (
            ('撤销', self.undo, self.document().isUndoAvailable()),
            ('重做', self.redo, self.document().isRedoAvailable()),
            (None, None, True),
            ('剪切', self.cut, self.textCursor().hasSelection()),
            ('复制', self.copy, self.textCursor().hasSelection()),
            ('粘贴', self.paste, self.canPaste()),
            (None, None, True),
            ('全选', self.selectAll, not self.document().isEmpty()),
        )
        for text, callback, enabled in actions:
            if text is None:
                menu.addSeparator()
                continue
            action = menu.addAction(text)
            action.setEnabled(enabled)
            action.triggered.connect(callback)
        return menu

    def insertFromMimeData(self, source):
        """拦截剪贴板粘贴：图片转 data URL 发信号，文本走默认插入。"""
        if source.hasImage():
            self.image_pasted.emit(self._image_to_data_url(source.imageData()))
            return
        super().insertFromMimeData(source)

    def dragEnterEvent(self, event):
        """接受图片或文件 URL 的拖入，其余交给默认处理。"""
        if event.mimeData().hasImage() or event.mimeData().hasUrls():
            event.acceptProposedAction()
            return
        super().dragEnterEvent(event)

    def dropEvent(self, event):
        """处理拖放：优先取图片数据，其次尝试把 URL 当本地图片文件加载。"""
        mime = event.mimeData()
        if mime.hasImage():
            self.image_pasted.emit(self._image_to_data_url(mime.imageData()))
            event.acceptProposedAction()
            return
        for url in mime.urls():
            path = url.toLocalFile()
            pixmap = QPixmap(path)
            if not pixmap.isNull():
                self.image_pasted.emit(self._image_to_data_url(pixmap.toImage()))
                event.acceptProposedAction()
                return
        super().dropEvent(event)

    def keyPressEvent(self, event: QKeyEvent):
        # 回车直接发送；Shift+Enter 则保留默认换行行为
        if event.key() in (Qt.Key_Return, Qt.Key_Enter) and not event.modifiers() & Qt.ShiftModifier:
            self.window()._send()
            event.accept()
            return
        super().keyPressEvent(event)

    def _resize_to_content(self):
        """按文档高度自适应输入框高度，范围限制在 38~120px。"""
        if not self.toPlainText().strip():
            self.setFixedHeight(38)
            return
        doc_height = int(self.document().size().height()) + 20
        self.setFixedHeight(max(38, min(120, doc_height)))


def _scaled_pixmap(pixmap, w, h, mode=Qt.KeepAspectRatio):
    """按屏幕 DPI 缩放，保证高清显示。"""
    screen = QApplication.primaryScreen()
    dpr = screen.devicePixelRatio() if screen else 1.0
    pw, ph = int(w * dpr), int(h * dpr)
    pm = pixmap.scaled(pw, ph, mode, Qt.SmoothTransformation)
    pm.setDevicePixelRatio(dpr)
    return pm


class Avatar(QLabel):
    """聊天消息头像，图片加载失败时回退为单字文本。"""

    def __init__(self, pixmap_path, fallback_text, is_user=False, parent=None, size=38, icon_size=30):
        """加载头像图片；失败时用名字首字生成彩色圆形占位。"""
        super().__init__(parent)
        self.setFixedSize(size, size)
        self.setAlignment(Qt.AlignCenter)
        pixmap = QPixmap(str(pixmap_path)) if pixmap_path else QPixmap()
        if not pixmap.isNull():
            self.setPixmap(_scaled_pixmap(pixmap, icon_size, icon_size))
        else:
            self.setText(fallback_text[:1])
        bg = '#dbeafe' if is_user else '#fff1e8'
        fg = '#1d4ed8' if is_user else '#c2410c'
        self.setStyleSheet(
            'QLabel{background:%s;color:%s;border-radius:%dpx;font-weight:600;}' % (bg, fg, size // 2)
        )


class PetContactButton(QPushButton):
    """飞书风格的宠物联系人按钮。"""

    def __init__(self, label, parent=None):
        """创建带宠物头像和名称的联系人行。"""
        super().__init__(parent)
        self.setCheckable(False)
        self.setFixedHeight(42)
        self.setCursor(Qt.PointingHandCursor)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.setStyleSheet(
            'QPushButton{background:transparent;color:#4f5b6b;border:none;'
            'border-left:3px solid transparent;border-radius:6px;text-align:left;padding:0 8px;}'
            'QPushButton:hover{background:#edf4ff;}'
            'QPushButton:checked{background:#e6f0ff;color:#1677ff;'
            'border-left-color:#3370b8;}'
        )
        row = QHBoxLayout(self)
        row.setContentsMargins(7, 0, 8, 0)
        row.setSpacing(8)
        self.avatar = Avatar(config.avatar_path('pet'), label, False, self, size=28, icon_size=22)
        self.name_label = QLabel(label, self)
        self.name_label.setStyleSheet('QLabel{background:transparent;border:none;font-size:13px;}')
        row.addWidget(self.avatar)
        row.addWidget(self.name_label, 1)

    def set_contact_name(self, label):
        """更新联系人名称。"""
        self.name_label.setText(label)


class ChatBridge(QWebChannel):
    """QWebChannel 桥：把消息推给 JS，接收 JS 的卡片按钮回调。

    选择 QWebChannel 而非 QWebEnginePage.runJavaScript 的原因：
    双向通信需要 JS → Python 的回调，QWebChannel 是官方推荐的跨层通信方案，
    避免轮询或注入全局变量等 hack 手法。
    """

    def __init__(self, parent=None):
        """注册名为 bridge 的对象供页面 JS 调用。"""
        super().__init__(parent)
        self._card_callback = None
        self._quote_callback = None
        self.registerObject('bridge', self)

    def set_card_callback(self, cb):
        """注册 JS 卡片按钮点击回调。"""
        self._card_callback = cb

    def set_quote_callback(self, cb):
        """注册 JS 消息引用点击回调。"""
        self._quote_callback = cb

    # JS 可调用的槽
    from PySide6.QtCore import Slot
    @Slot(str)
    def cardAction(self, value):
        if self._card_callback:
            self._card_callback(value)

    @Slot(str)
    def imagePasted(self, data_url):
        pass  # 留给扩展用

    @Slot(str)
    def copyText(self, text):
        """把文本写入系统剪贴板。

        WebEngine 里 navigator.clipboard 需要安全上下文和剪贴板权限，
        默认被拒且失败静默，因此 JS 侧复制统一走本桥。
        """
        QGuiApplication.clipboard().setText(str(text or ''))

    @Slot(str)
    def quoteActivated(self, quoted_text):
        if self._quote_callback:
            self._quote_callback(quoted_text)


class _WindowControlButton(QAbstractButton):
    """Windows 无边框窗口的系统控制按钮。"""

    def __init__(self, action, parent=None):
        """action 取 minimize/maximize/close，决定绘制哪种系统图标。"""
        super().__init__(parent)
        self.action = action
        self._maximized = False
        self.setFixedSize(32, 28)
        self.setFocusPolicy(Qt.NoFocus)
        self.setCursor(Qt.ArrowCursor)

    def set_maximized(self, maximized):
        """切换最大化/还原图标状态并重绘。"""
        self._maximized = bool(maximized)
        self.update()

    def paintEvent(self, event):
        """手绘最小化/最大化/关闭线条图标，悬停和按下时有反馈色。"""
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, False)
        hovered = self.underMouse()
        pressed = self.isDown()
        is_close = self.action == 'close'
        if hovered or pressed:
            background = '#d9e8fb' if pressed else '#edf4fc'
            if is_close:
                background = '#f4b4ae' if pressed else '#fbe2df'
            painter.fillRect(self.rect(), QColor(background))
        color = QColor('#ffffff')
        painter.setPen(QPen(color, 1))
        center_x = self.width() // 2
        center_y = self.height() // 2
        if self.action == 'minimize':
            painter.drawLine(center_x - 5, center_y, center_x + 5, center_y)
        elif self.action == 'maximize':
            if self._maximized:
                painter.drawRect(center_x - 5, center_y - 2, 8, 7)
                painter.drawRect(center_x - 2, center_y - 5, 8, 7)
            else:
                painter.drawRect(center_x - 5, center_y - 5, 10, 10)
        else:
            painter.drawLine(center_x - 5, center_y - 5, center_x + 5, center_y + 5)
            painter.drawLine(center_x + 5, center_y - 5, center_x - 5, center_y + 5)


class ChatWindow(QWidget):
    """完整文本聊天窗口。

    这个窗口把 Qt 输入区和 WebEngine 消息区组合在一起。history 由外层
    MiniPetApp 传入时，窗口只负责展示和提交消息；历史由 mini-claw 内核下发。
    """

    def __init__(self, pet_name='', parent=None, history=None, clear_history_callback=None, send_callback=None):
        super().__init__(parent)
        self.pet_name = pet_name
        self.history = history if history is not None else []
        self.clear_history_callback = clear_history_callback
        self.send_callback = send_callback
        self.worker = None
        self._stream_id = None
        self._stream_text = ''
        self.stream_tts = StreamTtsQueue(self, label='Chat TTS')
        self.pending_images = []  # 待发送图片的 data URL 列表
        self._web_ready = False  # WebEngine 页面是否加载完成
        self._pending_js = []  # 页面就绪前暂存的 JS 语句
        self.pet_contact = None
        self.setWindowTitle('与宠物聊天')
        self.setWindowIcon(QIcon(str(config.avatar_path('pet'))))
        self.resize(980, 680)  # 默认窗口尺寸
        self.setMinimumSize(QSize(760, 520))
        flags = Qt.Window
        if sys.platform == 'win32':
            flags |= Qt.FramelessWindowHint
        self.setWindowFlags(flags)
        self._init_ui()

    def _init_ui(self):
        """搭建整体布局：标题栏 + 左侧后端边栏 + 右侧聊天面板。"""
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        self.setObjectName('ChatWindowRoot')
        self.setStyleSheet('QWidget#ChatWindowRoot{font-family:Microsoft YaHei, Segoe UI, sans-serif;background:#4c79b1;border:3px solid #4c79b1;}')

        self.header = QWidget(self)
        self.header.setObjectName('ChatHeader')
        self.header.setFixedHeight(32)
        self.header.setStyleSheet('QWidget#ChatHeader{background:#3370b8;border:none;}')
        top_layout = QHBoxLayout(self.header)
        top_layout.setContentsMargins(14, 0, 10, 0)
        top_layout.addStretch(1)
        if sys.platform == 'win32':
            controls_layout = QHBoxLayout()
            controls_layout.setContentsMargins(0, 0, 0, 0)
            controls_layout.setSpacing(0)
            self._add_window_controls(controls_layout, self.header)
            top_layout.addLayout(controls_layout)
        root.addWidget(self.header)

        shell = QFrame(self)
        shell.setObjectName('ChatShell')
        shell.setStyleSheet('QFrame#ChatShell{background:#f4f7fb;border:1px solid #dfe6ef;border-radius:4px;}')
        shell_layout = QHBoxLayout(shell)
        shell_layout.setContentsMargins(0, 0, 0, 0)
        shell_layout.setSpacing(0)

        sidebar = QFrame(shell)
        sidebar.setObjectName('ChatBackendSidebar')
        sidebar.setFixedWidth(176)
        sidebar.setStyleSheet(
            'QFrame#ChatBackendSidebar{background:#f4f7fb;border:none;'
            'border-right:1px solid #d7e0eb;border-top-left-radius:4px;'
            'border-bottom-left-radius:4px;}'
        )
        sidebar_layout = QVBoxLayout(sidebar)
        sidebar_layout.setContentsMargins(8, 8, 8, 8)
        sidebar_layout.setSpacing(5)
        sidebar_title = QLabel('对话', sidebar)
        sidebar_title.setStyleSheet(
            'QLabel{color:#738198;background:transparent;font-size:12px;font-weight:600;}'
        )
        sidebar_layout.addWidget(sidebar_title)
        self.pet_contact = PetContactButton(self.pet_name or '宠物', sidebar)
        self.pet_contact.setCursor(Qt.ArrowCursor)
        sidebar_layout.addWidget(self.pet_contact)
        sidebar_layout.addStretch(1)
        shell_layout.addWidget(sidebar)

        chat_panel = QFrame(shell)
        chat_panel.setObjectName('ChatPanel')
        chat_panel.setStyleSheet(
            'QFrame#ChatPanel{background:#ffffff;border:none;'
            'border-top-right-radius:6px;border-bottom-right-radius:6px;}'
        )
        chat_layout = QVBoxLayout(chat_panel)
        chat_layout.setContentsMargins(0, 2, 2, 2)
        chat_layout.setSpacing(0)
        self.chat_header = QWidget(chat_panel)
        self.chat_header.setFixedHeight(44)
        self.chat_header.setStyleSheet('QWidget{background:#ffffff;border-bottom:1px solid #edf0f4;}')
        h_layout = QHBoxLayout(self.chat_header)
        h_layout.setContentsMargins(14, 0, 14, 0)
        self.avatar_widget = Avatar(config.avatar_path('pet'), self.pet_name or '宠', False, self.chat_header, size=32, icon_size=26)
        title_box = QHBoxLayout()
        title_box.setContentsMargins(0, 0, 0, 0)
        title_box.setSpacing(6)
        self.title_label = TitleLabel(self.pet_name or '宠物')
        self.title_label.setFont(QFont(self.title_label.font().family(), 12, QFont.DemiBold))
        self._title_box = title_box
        title_box.addWidget(self.title_label)
        h_layout.addWidget(self.avatar_widget)
        h_layout.addLayout(title_box, 1)
        self.clear_btn = TransparentToolButton(FIF.DELETE, self.chat_header)
        self.clear_btn.setFixedSize(28, 28)
        self.clear_btn.setToolTip('删除当前对话')
        self.clear_btn.clicked.connect(self._clear)
        h_layout.addWidget(self.clear_btn)
        chat_layout.addWidget(self.chat_header)

        # WebEngine 消息区
        self.web = QWebEngineView()
        self.web.setContextMenuPolicy(Qt.NoContextMenu)
        from PySide6.QtWebEngineCore import QWebEngineSettings
        settings = self.web.settings()
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True)
        self.bridge = ChatBridge(self)
        self.web.page().setWebChannel(self.bridge)
        self.web.loadFinished.connect(self._on_load_finished)
        html_path = config.RES_DIR / 'chat' / 'chat.html'
        html_text = html_path.read_text(encoding='utf-8')
        base_url = QUrl.fromLocalFile(str(html_path))
        self.web.setHtml(html_text, base_url)
        web_wrap = QWidget(chat_panel)
        web_wrap.setStyleSheet('QWidget{background:#ffffff;}')
        web_layout = QVBoxLayout(web_wrap)
        web_layout.setContentsMargins(0, 0, 2, 0)
        web_layout.addWidget(self.web)
        chat_layout.addWidget(web_wrap, 1)

        # 输入区
        input_bar = QWidget()
        input_bar.setStyleSheet('QWidget{background:#f7f8fa;}')
        input_layout = QVBoxLayout(input_bar)
        input_layout.setContentsMargins(18, 8, 18, 12)
        input_layout.setSpacing(4)
        self.preview_row = QHBoxLayout()
        self.preview_row.setContentsMargins(0, 0, 0, 0)
        self.preview_row.setSpacing(6)
        input_layout.addLayout(self.preview_row)

        # 引用预览栏（默认隐藏）
        self.quote_bar = QWidget(input_bar)
        self.quote_bar.setVisible(False)
        self.quote_bar.setStyleSheet(
            'QWidget{background:#eef4ff;border-left:3px solid #4080ff;border-radius:6px;padding:0px;}'
        )
        quote_bar_layout = QHBoxLayout(self.quote_bar)
        quote_bar_layout.setContentsMargins(10, 4, 6, 4)
        quote_bar_layout.setSpacing(6)
        self.quote_label = QLabel('', self.quote_bar)
        self.quote_label.setStyleSheet(
            'QLabel{color:#4060cc;font-size:12px;background:transparent;border:none;border-left:none;}'
        )
        self.quote_label.setWordWrap(False)
        from PySide6.QtWidgets import QPushButton as _QPushButton
        quote_close_btn = _QPushButton('×', self.quote_bar)
        quote_close_btn.setFixedSize(20, 20)
        quote_close_btn.setStyleSheet(
            'QPushButton{background:transparent;border:none;color:#8090bb;font-size:14px;}'
            'QPushButton:hover{color:#1677ff;}'
        )
        quote_close_btn.clicked.connect(self._clear_quote)
        quote_bar_layout.addWidget(self.quote_label, 1)
        quote_bar_layout.addWidget(quote_close_btn, 0)
        input_layout.addWidget(self.quote_bar)
        self._quoted_text = ''
        self.bridge.set_quote_callback(self._on_quote_activated)

        self.input = ChatInput(input_bar)
        self.input.image_pasted.connect(self._add_pending_image)
        self.input.setStyleSheet(
            'QTextEdit{background:#ffffff;border:1px solid #dfe3e8;border-radius:10px;padding:8px 12px;font-size:14px;}'
            'QTextEdit:focus{border:1px solid #8ab4f8;}'
            'QTextEdit:disabled{background:#f3f4f6;color:#9aa0a6;border:1px solid #e5e7eb;}'
        )
        input_layout.addWidget(self.input)
        chat_layout.addWidget(input_bar)
        shell_layout.addWidget(chat_panel, 1)
        outer = QWidget(self)
        outer_layout = QVBoxLayout(outer)
        outer_layout.setContentsMargins(6, 0, 6, 6)
        outer_layout.addWidget(shell)
        root.addWidget(outer, 1)

    def _add_window_controls(self, layout, parent):
        """把最小化/最大化/关闭三个自绘按钮加入标题栏。"""
        self.minimize_btn = _WindowControlButton('minimize', parent)
        self.maximize_btn = _WindowControlButton('maximize', parent)
        self.close_btn = _WindowControlButton('close', parent)
        for button in (self.minimize_btn, self.maximize_btn, self.close_btn):
            layout.addWidget(button)
        self.minimize_btn.setToolTip('最小化')
        self.maximize_btn.clicked.connect(self._toggle_maximized)
        self.close_btn.setToolTip('关闭')
        self.minimize_btn.clicked.connect(self.showMinimized)
        self.close_btn.clicked.connect(self.close)
        self._sync_maximize_button()

    def _toggle_maximized(self):
        """在最大化和还原之间切换窗口状态。"""
        if self.isMaximized():
            self.showNormal()
        else:
            self.showMaximized()

    def _sync_maximize_button(self):
        """按当前窗口状态同步最大化按钮的图标和提示文案。"""
        if not hasattr(self, 'maximize_btn'):
            return
        maximized = self.isMaximized()
        self.maximize_btn.setToolTip('还原' if maximized else '最大化')
        self.maximize_btn.set_maximized(maximized)

    def changeEvent(self, event):
        """窗口状态变化时刷新最大化按钮显示。"""
        super().changeEvent(event)
        if event.type() == QEvent.WindowStateChange:
            self._sync_maximize_button()

    def _interactive_title_rects(self):
        """收集标题栏上所有可点按钮的矩形，命中测试时把它们排除出拖动区。"""
        widgets = []
        for name in ('clear_btn', 'minimize_btn', 'maximize_btn', 'close_btn'):
            button = getattr(self, name, None)
            if button is not None:
                widgets.append(button)
        rects = []
        for widget in widgets:
            pos = widget.mapTo(self, widget.rect().topLeft())
            rects.append((pos.x(), pos.y(), widget.width(), widget.height()))
        return rects

    def nativeEvent(self, event_type, message):
        # Win32 无边框窗口需要手动处理 WM_NCHITTEST，否则系统不知道哪里是可拖动标题栏、
        # 哪里是可调整大小的边框，导致窗口无法拖动和 snap 布局失效
        if sys.platform != 'win32':
            return super().nativeEvent(event_type, message)
        msg = MSG.from_address(message.__int__())
        if msg.message == WM_NCHITTEST:
            point = POINT()
            if ctypes.windll.user32.GetCursorPos(ctypes.byref(point)):
                ctypes.windll.user32.ScreenToClient(int(self.winId()), ctypes.byref(point))
                get_dpi = getattr(ctypes.windll.user32, 'GetDpiForWindow', None)
                dpi = get_dpi(int(self.winId())) if get_dpi is not None else 96
                scale = (dpi or 96) / 96.0
                result = hit_test(
                    round(point.x / scale), round(point.y / scale), self.width(), self.height(),
                    self.header.height(), max(6, round(8 * scale)) / scale,
                    self._interactive_title_rects(), self.isMaximized(),
                )
                return True, result
        return super().nativeEvent(event_type, message)

    # ─── WebEngine 就绪后批量执行待办 JS ───

    def _on_load_finished(self, ok):
        # WebEngine 加载完成前的 JS 调用会静默失败；
        # _pending_js 队列确保 reload_history 等初始化操作在页面就绪后才执行
        if not ok:
            return
        self._web_ready = True
        self.reload_history()
        for js in self._pending_js:
            self.web.page().runJavaScript(js)
        self._pending_js.clear()

    def set_pet_name(self, pet_name):
        """更新宠物名并同步标题和侧栏联系人显示。"""
        self.pet_name = pet_name or '宠物'
        if hasattr(self, 'title_label'):
            self.title_label.setText(self.pet_name)
        if self.pet_contact is not None:
            self.pet_contact.set_contact_name(self.pet_name)

    def _update_input_state(self):
        """同步输入框状态；当前窗口始终发送到唯一的 mini-claw 内核。"""
        if not hasattr(self, 'input'):
            return  # 构造函数早期调用时输入框尚未创建
        self.input.setEnabled(True)
        self.input.setPlaceholderText('发送给宠物')

    def _on_quote_activated(self, quoted_text):
        """收到 JS 的引用事件后展示引用预览栏并聚焦输入框。"""
        self._quoted_text = quoted_text.strip()
        if self._quoted_text:
            summary = self._quoted_text[:80] + ('...' if len(self._quoted_text) > 80 else '')
            self.quote_label.setText('引用：' + summary)
            self.quote_bar.setVisible(True)
            self.input.setFocus()

    def _clear_quote(self):
        """清空引用状态并隐藏预览栏，同时通知 JS 清除高亮。"""
        self._quoted_text = ''
        self.quote_bar.setVisible(False)
        self.quote_label.setText('')
        self._js('Chat.clearQuote()')

    def _js(self, code):
        """页面就绪则立即执行 JS，否则入队等待加载完成。"""
        if self._web_ready:
            self.web.page().runJavaScript(code)
        else:
            self._pending_js.append(code)

    # ─── 消息构建工具 ───

    def _msg_dict(self, role, content, msg_id=None):
        """把 str 或 blocks list 转成 chat.js 需要的 msg dict。"""
        avatar_url = QUrl.fromLocalFile(str(config.avatar_path('user' if role == 'user' else 'pet'))).toString()
        name = '我' if role == 'user' else (self.pet_name or '宠物')
        blocks = self._normalize_blocks(content)
        return {
            'id': msg_id or str(uuid.uuid4()),
            'role': role,
            'name': name,
            'backend': '',
            'avatar': avatar_url,
            'content': blocks,
        }

    def _normalize_blocks(self, content):
        # 统一把 str、list[dict] 等多种输入格式归一化为 chat.js 能直接渲染的 blocks 结构，
        # 避免在各消息构建处散落重复的格式转换逻辑
        if isinstance(content, str):
            return [{'type': 'text', 'text': content}]
        if isinstance(content, list):
            blocks = []
            for b in content:
                t = b.get('type') or b.get('tag')
                if t == 'text':
                    blk = {'type': 'text', 'text': b.get('text', '')}
                    if b.get('quote'):
                        blk['quote'] = b['quote']
                    blocks.append(blk)
                elif t == 'image':
                    src = b.get('src') or b.get('path') or b.get('image_key') or ''
                    blocks.append({'type': 'image', 'src': src, 'alt': b.get('alt', '图片')})
                elif t == 'code':
                    blocks.append({'type': 'code', 'language': b.get('language', ''), 'text': b.get('text', '')})
                elif t == 'card':
                    blocks.append(b)
            return blocks or [{'type': 'text', 'text': ''}]
        return [{'type': 'text', 'text': str(content)}]

    # ─── 消息区操作 ───

    def _push_message(self, role, content, msg_id=None):
        """把一条完整消息追加到消息区。"""
        msg = self._msg_dict(role, content, msg_id)
        self._js('Chat.appendMessage(%s)' % json.dumps(msg, ensure_ascii=False))

    def _start_stream(self, msg_id):
        """在消息区创建一条空的流式 assistant 气泡。"""
        self._stream_id = msg_id
        self._stream_text = ''
        avatar_url = QUrl.fromLocalFile(str(config.avatar_path('pet'))).toString()
        self._js('Chat.startStream(%s)' % json.dumps({
            'id': msg_id,
            'role': 'assistant',
            'name': self.pet_name or '宠物',
            'backend': '',
            'avatar': avatar_url,
        }, ensure_ascii=False))

    def reload_history(self):
        """清空消息区并按 history 重新渲染，空历史时显示欢迎语。"""
        self._js('Chat.clear()')
        if not self.history:
            self._push_message('assistant', '主人好呀，想聊点什么？')
            return
        for msg in self.history:
            role = msg.get('role')
            if role in ('user', 'assistant'):
                self._js('Chat.appendMessage(%s)' % json.dumps(
                    self._msg_dict(role, msg.get('content', '')),
                    ensure_ascii=False,
                ))

    # ─── 输入区 ───

    def _add_pending_image(self, data_url):
        """记录待发图片并在输入框上方显示 48px 缩略图。"""
        self.pending_images.append(data_url)
        import base64
        from PySide6.QtGui import QImage
        img = QImage()
        img.loadFromData(base64.b64decode(data_url.split(',', 1)[1]))
        thumb = QLabel(self.input.parent())  # 必须有 parent，否则浮成顶层窗口
        thumb.setFixedSize(48, 48)
        thumb.setStyleSheet('QLabel{border:1px solid #dfe3e8;border-radius:6px;background:#f0f0f0;}')
        thumb.setPixmap(QPixmap.fromImage(img).scaled(46, 46, Qt.KeepAspectRatio, Qt.SmoothTransformation))
        self.preview_row.addWidget(thumb)

    def _build_user_content(self, text, quote=''):
        """把文本、引用和待发图片组装成发送内容；纯文本时直接返回字符串。"""
        if not self.pending_images and not quote:
            return text
        blocks = []
        if text:
            block = {'type': 'text', 'text': text}
            if quote:
                block['quote'] = quote[:80] + ('...' if len(quote) > 80 else '')
            blocks.append(block)
        for img in self.pending_images:
            blocks.append({'type': 'image', 'src': img, 'alt': '图片'})
        return blocks or text

    def _send(self):
        """发送用户输入，启动一条流式 assistant 消息。

        优先走外层 send_callback（由 MiniPetApp 注入内核调度逻辑）；
        没有注入时显示统一的内核连接提示。
        """
        text = self.input.toPlainText().strip()
        if (not text and not self.pending_images) or self.worker is not None:
            return
        quoted = self._quoted_text
        # 把引用内容拼入发送文本，让 mini-claw 内核能理解上下文；展示层仅在 quote 字段显示原文
        if quoted and text:
            summary = quoted[:60] + ('...' if len(quoted) > 60 else '')
            send_text = '对方引用了"%s"，他的输入是：%s' % (summary, text)
        else:
            send_text = text
        content = self._build_user_content(send_text, quote=quoted if quoted and text else '')
        self._clear_quote()
        self.input.clear()
        self.pending_images = []
        while self.preview_row.count():
            w = self.preview_row.takeAt(0).widget()
            if w:
                w.deleteLater()
        self.input.setPlaceholderText('发送给宠物')
        # 聊天窗口的回复只在窗口内显示，不触发外部 TTS。
        stream_id = str(uuid.uuid4())
        self._stream_id = stream_id
        self._reset_stream_tts()
        self.input.setEnabled(False)
        if self.send_callback:
            self.worker = self.send_callback(
                content,
                lambda: self._show_sent_user_then_stream(content, stream_id),
                lambda d: self._on_delta(stream_id, d),
                lambda ok, t: self._on_reply(stream_id, ok, t),
            )
            if not self.worker:
                self._on_reply(stream_id, False, '当前后端发送失败。')
            return
        self._on_reply(stream_id, False, '当前 mini-claw 服务未连接。')

    def _show_sent_user_then_stream(self, content, stream_id):
        """内核通道确认后，先展示用户消息再开流式气泡。"""
        self._push_message('user', content)
        self._start_stream(stream_id)

    def _memory_message_limit(self):
        """本地不再构造模型上下文，历史由 mini-claw 内核管理。"""
        return 0

    def _build_messages(self):
        """兼容旧测试的上下文接口；真实发送由 mini-claw 内核管理。"""
        return []

    def _on_delta(self, stream_id, text):
        """收到流式增量后累加缓存并推给消息区。"""
        if text:
            self._stream_text += text
            escaped = json.dumps(text, ensure_ascii=False)
            self._js('Chat.appendDelta(%s, %s)' % (json.dumps(stream_id), escaped))

    def _on_reply(self, stream_id, success, text):
        """流式回复结束：定稿气泡；历史由 mini-claw 内核统一持久化。"""
        # stream_id 用于核对是否是当前会话的回复，避免多次快速发送时串流
        is_current_session = stream_id == self._stream_id
        if is_current_session:
            self.worker = None
            self._update_input_state()
        if success:
            final = text.strip() or '嗯。'
            if is_current_session:
                self._js('Chat.endStream(%s, %s)' % (json.dumps(stream_id), json.dumps(final, ensure_ascii=False)))
            self._stream_text = final
        else:
            self._reset_stream_tts()
            if is_current_session:
                self._js('Chat.endStream(%s, %s)' % (json.dumps(stream_id), json.dumps('⚠️ ' + text[:200], ensure_ascii=False)))
        if is_current_session:
            self.input.setFocus()

    def _reset_stream_tts(self):
        """清空 TTS 播放队列。"""
        self.stream_tts.reset()

    def clear_history(self, show_hint=False):
        """停掉 TTS、清空历史和消息区，可选显示清空提示。"""
        stop_tts()
        self._reset_stream_tts()
        if self.clear_history_callback:
            self.clear_history_callback()
            self.history = []
        else:
            self.history.clear()
        self._js('Chat.clear()')
        if show_hint:
            self._push_message('assistant', '对话已清空，重新开始吧。')

    def _clear(self):
        self.clear_history(show_hint=True)

    def _fit_to_screen(self):
        """把窗口位置夹回屏幕可见区域内，防止拖出后找不回。"""
        screen = self.screen() or QApplication.primaryScreen()
        if screen is None:
            return
        area = screen.availableGeometry()
        x = min(max(self.x(), area.left()), area.right() - self.width() + 1)
        y = min(max(self.y(), area.top()), area.bottom() - self.height() + 1)
        self.move(x, y)

    def shutdown(self):
        """停止 TTS 并等待后台 Worker 线程退出（最多 2 秒）。"""
        stop_tts()
        self._reset_stream_tts()
        for attr in ('worker',):
            w = getattr(self, attr, None)
            if w is not None and w.isRunning():
                w.requestInterruption()
                w.quit()
                w.wait(2000)
            setattr(self, attr, None)

    def closeEvent(self, event):
        self.shutdown()
        super().closeEvent(event)

    def show_window(self):
        """显示/激活窗口，调整到可见区域并聚焦输入框。"""
        if not self.isVisible():
            self.show()
        self._fit_to_screen()
        self.activateWindow()
        self.raise_()
        self.input.setFocus()
