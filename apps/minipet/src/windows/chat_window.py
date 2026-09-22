# coding:utf-8
"""
文本聊天窗口。

聊天内容由 res/chat/chat.html 渲染。该窗口是 Pi 会话历史的只读查看器：
输入、工具调用和授权操作都在桌宠浮窗/语音入口完成，不在这里产生副作用。
"""

import ctypes
import json
import sys
import uuid

if sys.platform == 'win32':
    from ctypes.wintypes import MSG, POINT

from PySide6.QtCore import QEvent, QSize, Qt, QUrl
from PySide6.QtGui import QColor, QFont, QGuiApplication, QIcon, QPainter, QPen, QPixmap
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import (QAbstractButton, QApplication, QFrame, QHBoxLayout, QLabel, QPushButton, QSizePolicy, QVBoxLayout, QWidget)
from qfluentwidgets import TitleLabel

import config
from windows.win32_frameless import WM_NCHITTEST, hit_test


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
    """只读历史页的桥接层，仅提供复制和历史卡片展示所需的最小能力。"""

    def __init__(self, parent=None):
        """注册名为 bridge 的对象供页面 JS 调用。"""
        super().__init__(parent)
        self._card_callback = None
        self.registerObject('bridge', self)

    def set_card_callback(self, cb):
        """注册 JS 卡片按钮点击回调。"""
        self._card_callback = cb

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
    """Pi 会话历史查看器，不提供发送、清空或授权能力。"""

    def __init__(self, pet_name='', parent=None, history=None):
        super().__init__(parent)
        self.pet_name = pet_name
        self.history = history if history is not None else []
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
        """搭建只读历史布局：标题栏、联系人栏和消息展示区。"""
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
        readonly_hint = QLabel('历史记录 · 只读', self.chat_header)
        readonly_hint.setStyleSheet('QLabel{color:#8a96a8;font-size:11px;background:transparent;}')
        title_box.addWidget(readonly_hint)
        h_layout.addWidget(self.avatar_widget)
        h_layout.addLayout(title_box, 1)
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
        for name in ('minimize_btn', 'maximize_btn', 'close_btn'):
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

    def reload_history(self):
        """清空消息区并按内核历史投影重新渲染。"""
        self._js('Chat.clear()')
        if not self.history:
            self._push_message('assistant', '还没有会话记录。请通过桌宠输入框或语音入口开始对话。')
            return
        for msg in self.history:
            role = msg.get('role')
            if role in ('user', 'assistant'):
                self._js('Chat.appendMessage(%s)' % json.dumps(
                    self._msg_dict(role, msg.get('content', '')),
                    ensure_ascii=False,
                ))

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
        """只读窗口没有独立会话或后台任务，保留统一生命周期接口。"""
        return None

    def closeEvent(self, event):
        self.shutdown()
        super().closeEvent(event)

    def show_window(self):
        """显示/激活只读历史窗口，调整到可见区域。"""
        if not self.isVisible():
            self.show()
        self._fit_to_screen()
        self.activateWindow()
        self.raise_()
        self.web.setFocus()
