# coding:utf-8
"""桌宠相关弹出菜单。"""

import time

from PySide6.QtCore import QEasingCurve, QEvent, QParallelAnimationGroup, QPropertyAnimation, QPoint, QRectF, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QAction, QColor, QFont, QFontMetrics, QIcon, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QApplication, QFrame, QGridLayout, QHBoxLayout, QLabel, QMenu, QPushButton, QVBoxLayout
from qfluentwidgets import FluentIcon as FIF

import config
import theme as _theme
from widgets.ui_utils import clamp_popup_pos


def build_pet_context_menu(owner, include_actions=False):
    """构建桌宠右键菜单：设置/聊天/语音/彩蛋入口、动作子菜单和角色切换。"""
    # 右键菜单每次都重建，避免主题切换后样式残留；内容轻量，重建开销可忽略
    menu = QMenu(owner)
    t = _theme.current_theme()
    menu.setStyleSheet('''
        QMenu {
            background: %(bg)s;
            border: 1px solid %(border)s;
            border-radius: 10px;
            padding: 4px 0;
            font-family: "Microsoft YaHei UI", "Microsoft YaHei";
            font-size: 13px;
        }
        QMenu::item {
            padding: 6px 20px 6px 14px;
            color: %(text)s;
            border-radius: 6px;
            margin: 1px 4px;
        }
        QMenu::item:selected {
            background: %(btn_hover)s;
            color: %(primary)s;
        }
        QMenu::item:disabled { color: %(disabled)s; }
        QMenu::separator {
            height: 1px;
            background: %(border)s;
            margin: 3px 10px;
        }
    ''' % {
        'bg': t['menu_bg'],
        'border': t['menu_border'],
        'text': t['easter_fg'],
        'btn_hover': t['menu_btn_hover'],
        'primary': t['menu_primary'],
        'disabled': '#a0a8b4',
    })
    icon_dir = config.RES_DIR / 'icons'
    system_icon_dir = icon_dir / 'system'
    # 标题项：展示当前宠物名，置灰不可点，仅作菜单头
    if config.current_pet:
        title = QAction(QIcon(str(system_icon_dir / 'minipet.svg')), config.pet_display_name(), menu)
        title.setEnabled(False)
        menu.addAction(title)
        menu.addSeparator()

    # 四个主功能入口，各自通过 owner 上的信号/方法分发
    system_action = QAction(QIcon(str(icon_dir / 'SystemPanel.png')), '设置', menu)
    system_action.triggered.connect(owner.show_settings.emit)
    chat_action = QAction(QIcon(str(icon_dir / 'Dialogue_icon.png')), '聊天', menu)
    chat_action.triggered.connect(owner.chat_requested.emit)
    voice_chat_action = QAction(FIF.CHAT.icon(), '语音聊天', menu)
    voice_chat_action.triggered.connect(owner.voice_chat_requested.emit)
    easter_action = QAction('彩蛋小铺', menu)
    easter_action.triggered.connect(owner.show_easter_menu)
    menu.addAction(system_action)
    menu.addAction(chat_action)
    menu.addAction(voice_chat_action)
    menu.addAction(easter_action)
    menu.addSeparator()

    if include_actions:
        # 动作子菜单：逐项绑定回调时用默认参数捕获 name，避免闭包共享变量问题
        act_menu = menu.addMenu(QIcon(str(icon_dir / 'jump.svg')), '动作')
        if owner.profile:
            for name in owner.profile.acts.keys():
                action = QAction(QIcon(str(icon_dir / 'jump.svg')), name, act_menu)
                action.triggered.connect(lambda checked=False, n=name: owner.play_action(n))
                act_menu.addAction(action)
        if not act_menu.actions():
            # 桌宠档案未定义动作时的占位项
            empty_action = QAction('无可用动作', act_menu)
            empty_action.setEnabled(False)
            act_menu.addAction(empty_action)

    # 角色切换子菜单：当前角色打勾标记
    role_menu = menu.addMenu(QIcon(str(system_icon_dir / 'character.svg')), '角色切换')
    for pet in config.get_pet_list():
        action = QAction(QIcon(str(system_icon_dir / 'character.svg')), pet, role_menu)
        # 同样用默认参数捕获 pet，防止 lambda 闭包晚绑定
        action.setCheckable(True)
        action.setChecked(pet == config.current_pet)
        action.triggered.connect(lambda checked=False, p=pet: owner.load_pet(p))
        role_menu.addAction(action)
    quit_action = QAction(FIF.POWER_BUTTON.icon(), '退出', menu)
    quit_action.triggered.connect(owner.quit)
    menu.addAction(quit_action)
    return menu


class PetDropIntentPopup(QFrame):
    """用户向桌宠拖放内容后，用来选择总结、起草回复等处理意图的弹窗。"""

    intent_selected = Signal(dict, str)   # 参数：(拖放内容, 选中的意图标识)

    def __init__(self, drop_payload, x, y, parent=None):
        """按拖放内容构建弹窗并在拖放点附近弹出；drop_payload 携带 kind/items/preview。"""
        super().__init__(parent)
        self.drop_payload = drop_payload
        self.anim_group = None
        # Tool/NoDropShadowWindowHint 组合：置顶且不抢焦点，避免打断用户当前操作
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool | Qt.NoDropShadowWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setWindowOpacity(0.0)
        t = _theme.current_theme()
        self.setStyleSheet('''
            QFrame#DropCard {
                border: 1px solid %(border)s;
                border-radius: 16px;
                background: %(bg)s;
            }
            QLabel { border: none; background: transparent; color: #1f2328; font-family: "Microsoft YaHei UI", "Microsoft YaHei"; }
            QLabel#DropTitle { font-size: 14px; font-weight: 700; }
            QLabel#DropDesc { color: #68707d; font-size: 12px; }
            QPushButton { border: none; border-radius: 12px; background: %(btn_bg)s; color: #1f2328; padding: 7px 10px; }
            QPushButton:hover { background: %(btn_hover)s; }
            QPushButton#PrimaryButton { background: %(primary)s; color: white; }
            QPushButton#PrimaryButton:hover { background: %(primary)s; opacity: 0.85; }
            QPushButton#QuietButton { background: transparent; color: #8b8f99; }
            QPushButton#QuietButton:hover { background: %(btn_bg)s; color: #4b5563; }
        ''' % {
            'bg': t['menu_bg'],
            'border': t['menu_border'],
            'btn_bg': t['menu_btn_bg'],
            'btn_hover': t['menu_btn_hover'],
            'primary': t['menu_primary'],
        })
        card = QFrame(self)
        card.setObjectName('DropCard')
        root = QVBoxLayout(card)
        root.setContentsMargins(14, 12, 14, 12)
        root.setSpacing(8)

        title = QLabel(self._title_text(), card)
        title.setObjectName('DropTitle')  # 加粗主标题
        root.addWidget(title)

        desc = QLabel(self._description_text(), card)
        desc.setObjectName('DropDesc')  # 灰色小字预览区
        desc.setWordWrap(True)
        desc.setMaximumWidth(320)
        root.addWidget(desc)

        first_row = QHBoxLayout()
        first_row.setSpacing(6)
        # 第一行放三个高频意图，'总结' 为主按钮强调
        for intent, label, primary in (
            ('summarize', '总结', True),
            ('create_task', '生成待办', False),
            ('draft_reply', '起草回复', False),
        ):
            btn = QPushButton(label, card)
            if primary:
                btn.setObjectName('PrimaryButton')
            btn.clicked.connect(lambda checked=False, i=intent: self._select(i))
            first_row.addWidget(btn)
        root.addLayout(first_row)

        second_row = QHBoxLayout()
        second_row.setSpacing(6)
        # 第二行放低频/辅助意图，'取消' 用弱化样式
        for intent, label in (
            ('send_to_lark', '发到飞书'),
            ('ask', '问它怎么处理'),
            ('cancel', '取消'),
        ):
            btn = QPushButton(label, card)
            if intent == 'cancel':
                btn.setObjectName('QuietButton')
            btn.clicked.connect(lambda checked=False, i=intent: self._select(i))
            second_row.addWidget(btn)
        root.addLayout(second_row)

        outer = QHBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(card)
        self.adjustSize()
        end_pos = clamp_popup_pos(QPoint(int(x - self.width() / 2), int(y - self.height() - 18)), self.size(), QPoint(int(x), int(y)))
        self.move(end_pos + QPoint(0, 10))
        self._animate_in(end_pos)
        # 18秒后自动关闭，防止用户忘记处理时弹窗永久占屏；比彩蛋菜单更长，因为意图选择需要更多思考时间
        QTimer.singleShot(18000, self.close)

    def _title_text(self):
        """按拖放内容的类型（文件/链接/图片/文本）生成标题。"""
        kind = self.drop_payload.get('kind')
        count = len(self.drop_payload.get('items') or [])
        if kind == 'file':
            return '收到 %d 个文件' % count
        if kind == 'url':
            return '收到 %d 个链接' % count
        if kind == 'image':
            return '收到图片'
        return '收到一段文字'

    def _description_text(self):
        """返回内容预览文本，超长截断到 90 字符。"""
        preview = self.drop_payload.get('preview') or ''
        if len(preview) > 90:
            preview = preview[:90] + '…'
        return preview or '要我怎么处理这个内容？'

    def _animate_in(self, end_pos):
        """入场动画：位置上滑 + 透明度渐显并行播放。"""
        self.show()
        self.raise_()
        pos_anim = QPropertyAnimation(self, b'pos', self)
        pos_anim.setDuration(160)
        pos_anim.setStartValue(self.pos())
        pos_anim.setEndValue(end_pos)
        pos_anim.setEasingCurve(QEasingCurve.OutCubic)
        opacity_anim = QPropertyAnimation(self, b'windowOpacity', self)
        opacity_anim.setDuration(140)
        opacity_anim.setStartValue(0.0)
        opacity_anim.setEndValue(1.0)
        self.anim_group = QParallelAnimationGroup(self)
        self.anim_group.addAnimation(pos_anim)
        self.anim_group.addAnimation(opacity_anim)
        self.anim_group.start()

    def _select(self, intent):
        """处理用户点选的意图；取消则直接关闭不广播。"""
        if intent != 'cancel':
            self.intent_selected.emit(self.drop_payload, intent)
        self.close()

    def changeEvent(self, event):
        """窗口失活（用户点了别处）时自动关闭，避免残留遮挡。"""
        if event.type() == QEvent.ActivationChange and not self.isActiveWindow():
            self.close()
        super().changeEvent(event)


class EasterActionButton(QPushButton):
    """彩蛋菜单中的自绘动作按钮。"""

    def __init__(self, icon_text, label, subtitle, parent=None):
        """icon_text 可为文件路径或 emoji/字符图标；label/subtitle 为双行文字。"""
        super().__init__(parent)
        self.icon_text = icon_text
        self.label = label
        self.subtitle = subtitle
        self.setCursor(Qt.PointingHandCursor)
        self.setFixedSize(164, 72)
        self.setText('')

    def paintEvent(self, event):
        # 全部自绘（不走 QStyle），是为了实现圆角背景+左侧图标圆圈+右侧双行文字的自定义布局，
        # 同时保持 hover/press 状态色的完全控制
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        rect = self.rect().adjusted(2, 2, -2, -2)
        # 三态配色：按下最深、hover 次之、常态最浅，均为暖金色系
        if self.isDown():
            bg = QColor(246, 217, 158, 245)
            border = QColor(204, 150, 72, 180)
        elif self.underMouse():
            bg = QColor(255, 236, 194, 250)
            border = QColor(218, 157, 65, 185)
        else:
            bg = QColor(255, 247, 226, 240)
            border = QColor(235, 204, 144, 125)
        painter.setPen(QPen(border, 1))
        painter.setBrush(bg)
        painter.drawRoundedRect(rect, 18, 18)

        icon_rect = QRectF(rect.left() + 10, rect.top() + 14, 40, 40)
        # 左侧 40x40 圆形图标底座
        painter.setBrush(QColor(255, 255, 255, 205))
        painter.setPen(QPen(QColor(232, 191, 112, 120), 1))
        painter.drawEllipse(icon_rect)

        # 图标内容含路径特征时按图片文件绘制，否则按文本（emoji）绘制
        if '/' in self.icon_text or '\\' in self.icon_text or '.png' in self.icon_text.lower():
            from pathlib import Path
            icon_path = Path(self.icon_text) if not self.icon_text.startswith('res/') else config.RES_DIR / self.icon_text.replace('res/', '')
            if icon_path.exists():
                pixmap = QPixmap(str(icon_path))
                if not pixmap.isNull():
                    scaled = pixmap.scaled(int(icon_rect.width()), int(icon_rect.height()), Qt.KeepAspectRatio, Qt.SmoothTransformation)
                    x_offset = (icon_rect.width() - scaled.width()) / 2
                    y_offset = (icon_rect.height() - scaled.height()) / 2
                    painter.drawPixmap(int(icon_rect.x() + x_offset), int(icon_rect.y() + y_offset), scaled)
        else:
            font = QFont('Microsoft YaHei UI', 19)
            painter.setFont(font)
            painter.setPen(QColor(92, 59, 24))
            painter.drawText(icon_rect, Qt.AlignCenter, self.icon_text)

        # 右侧双行文字：标题加粗 + 副标题淡色，均超长省略
        text_rect = QRectF(rect.left() + 58, rect.top() + 11, rect.width() - 68, 24)
        font = QFont('Microsoft YaHei UI', 10, QFont.Bold)
        painter.setFont(font)
        painter.setPen(QColor(82, 52, 22))
        title = QFontMetrics(font).elidedText(self.label, Qt.ElideRight, int(text_rect.width()))
        painter.drawText(text_rect, Qt.AlignLeft | Qt.AlignVCenter, title)
        sub_rect = QRectF(rect.left() + 58, rect.top() + 36, rect.width() - 68, 22)
        font = QFont('Microsoft YaHei UI', 8)
        painter.setFont(font)
        painter.setPen(QColor(122, 82, 38, 185))
        subtitle = QFontMetrics(font).elidedText(self.subtitle, Qt.ElideRight, int(sub_rect.width()))
        painter.drawText(sub_rect, Qt.AlignLeft | Qt.AlignVCenter, subtitle)


class PetEasterMenu(QFrame):
    """桌宠彩蛋功能入口菜单。"""

    def __init__(self, x, y, actions, parent=None):
        """actions 为 (icon_text, label, subtitle, callback) 四元组列表，两列网格排布。"""
        super().__init__(parent)
        self.anim_group = None
        self._owner = parent
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool | Qt.NoDropShadowWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setWindowOpacity(0.0)
        self.setFixedWidth(394)  # 两列按钮 + 边距所需的固定宽度
        self.setStyleSheet('''
            QFrame#EasterCard {
                border: 1px solid rgba(218, 190, 132, 230);
                border-radius: 24px;
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 rgba(255, 251, 239, 252), stop:1 rgba(255, 240, 210, 250));
            }
            QLabel { border: none; background: transparent; color: #5c3b18; font-family: "Microsoft YaHei UI", "Microsoft YaHei"; }
            QLabel#EasterTitle { font-size: 17px; font-weight: 800; }
            QLabel#EasterSubTitle { font-size: 10px; color: rgba(116, 78, 36, 190); }
        ''')
        card = QFrame(self)
        card.setObjectName('EasterCard')
        root = QVBoxLayout(card)
        root.setContentsMargins(18, 15, 18, 18)
        root.setSpacing(10)

        title_row = QHBoxLayout()
        title_row.setSpacing(8)
        # 标题区：装饰符号 + 主标题 + 副标题
        mark = QLabel('✦', card)
        mark.setFixedWidth(18)  # 装饰符号列宽，保证标题左对齐
        mark.setStyleSheet('font-size: 16px; color: #c98a2e; font-weight: 900;')
        title_col = QVBoxLayout()
        title_col.setSpacing(0)
        title = QLabel('彩蛋小铺', card)
        title.setObjectName('EasterTitle')
        subtitle = QLabel('摸鱼、占卜和一点点玄学', card)  # 副标题定下轻松基调
        subtitle.setObjectName('EasterSubTitle')
        title_col.addWidget(title)
        title_col.addWidget(subtitle)
        title_row.addWidget(mark)
        title_row.addLayout(title_col)
        title_row.addStretch(1)
        root.addLayout(title_row)

        grid = QGridLayout()
        grid.setHorizontalSpacing(10)
        grid.setVerticalSpacing(10)
        for index, action in enumerate(actions):
            icon_text, label, subtitle, callback = action
            btn = EasterActionButton(icon_text, label, subtitle, card)
            # 每两个按钮换一行，形成两列网格
            btn.clicked.connect(lambda checked=False, cb=callback: self._trigger(cb))
            grid.addWidget(btn, index // 2, index % 2)
        root.addLayout(grid)

        outer = QHBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(card)
        self.adjustSize()
        pos = clamp_popup_pos(QPoint(int(x - self.width() / 2), int(y - self.height() - 24)), self.size(), QPoint(int(x), int(y)))
        self.move(pos + QPoint(0, 8))
        self._animate_in(pos)
        # 8秒后自动关闭：彩蛋功能定位为轻量互动，不需要用户长期停留
        QTimer.singleShot(8000, self.close)

    def _trigger(self, callback):
        """先关菜单再执行回调，避免回调弹出的窗口被关闭事件误伤。"""
        self.close()
        callback()

    def _animate_in(self, end_pos):
        """入场动画：透明度渐显 + 位置上滑并行。"""
        self.show()
        self.raise_()
        self.activateWindow()
        opacity_anim = QPropertyAnimation(self, b'windowOpacity', self)
        opacity_anim.setDuration(140)
        opacity_anim.setStartValue(0.0)
        opacity_anim.setEndValue(1.0)
        opacity_anim.setEasingCurve(QEasingCurve.OutCubic)
        pos_anim = QPropertyAnimation(self, b'pos', self)
        pos_anim.setDuration(160)
        pos_anim.setStartValue(self.pos())
        pos_anim.setEndValue(end_pos)
        pos_anim.setEasingCurve(QEasingCurve.OutCubic)
        self.anim_group = QParallelAnimationGroup(self)
        self.anim_group.addAnimation(opacity_anim)
        self.anim_group.addAnimation(pos_anim)
        self.anim_group.start()

    def leaveEvent(self, event):
        """鼠标移出不自动关闭：彩蛋菜单需点击或超时关闭。"""
        super().leaveEvent(event)

    def mousePressEvent(self, event):
        """右键仅用于关闭菜单。"""
        if event.button() == Qt.RightButton:
            self.close()
            event.accept()
            return
        super().mousePressEvent(event)

    def changeEvent(self, event):
        """窗口失活时自动关闭。"""
        if event.type() == QEvent.ActivationChange and not self.isActiveWindow():
            self.close()
        super().changeEvent(event)

    def closeEvent(self, event):
        """关闭时给 owner 设置 0.4s 的快捷菜单屏蔽窗口。"""
        if self._owner is not None:
            # 任意菜单关闭后，短时间内不允许快捷菜单重新打开，避免同一次点击关闭后又弹出。
            self._owner.block_quick_menu_until = time.monotonic() + 0.4
        super().closeEvent(event)


class PetQuickMenu(QFrame):
    """鼠标靠近桌宠时显示的极简快捷菜单。"""

    def __init__(self, x, top_y, bottom_y, on_settings, on_chat, on_voice_chat, on_quit, on_share_screen, on_random_pet=None, share_screen_active=False, voice_chat_active=False, parent=None):
        """五个图标按钮单行排布；top_y/bottom_y 为桌宠上下边界，用于定位在上方。"""
        super().__init__(parent)
        self.anim_group = None
        self._owner = parent
        # Tool + NoDropShadowWindowHint：置顶不抢焦点、无系统阴影
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool | Qt.NoDropShadowWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setWindowOpacity(0.0)
        t = _theme.current_theme()
        self.setStyleSheet('''
            QFrame#QuickMenuCard {
                border: 1px solid %(border)s;
                border-radius: 17px;
                background: %(bg)s;
            }
            QPushButton {
                border: none;
                border-radius: 10px;
                background: transparent;
                padding: 5px;
            }
            QPushButton:hover { background: %(btn_hover)s; }
            QPushButton:pressed { background: %(btn_bg)s; }
            QPushButton#VoiceChatBtn:checked { background: %(btn_bg)s; border: 1px solid %(border)s; }
            QPushButton#VoiceChatBtn:hover { background: %(btn_hover)s; }
            QPushButton#VoiceChatBtn:checked:hover { background: %(btn_bg)s; }
        ''' % {
            'bg': t['menu_bg'],
            'border': t['menu_border'],
            'btn_bg': t['menu_btn_bg'],
            'btn_hover': t['menu_btn_hover'],
        })
        card = QFrame(self)
        card.setObjectName('QuickMenuCard')
        row = QHBoxLayout(card)
        row.setContentsMargins(8, 6, 8, 6)
        row.setSpacing(4)
        settings_btn = QPushButton(card)
        # 按钮顺序固定：设置 → 聊天 → 语音球 → 随机宠物 → 退出
        chat_btn = QPushButton(card)
        voice_chat_btn = QPushButton(card)
        random_pet_btn = QPushButton(card)
        voice_chat_btn.setObjectName('VoiceChatBtn')
        voice_chat_btn.setCheckable(True)   # checked 态表示语音会话进行中
        quit_btn = QPushButton(card)
        settings_btn.setIcon(FIF.SETTING.icon())
        chat_btn.setIcon(QIcon(str(config.RES_DIR / 'icons' / 'Dialogue_icon.png')))
        voice_chat_btn.setIcon(QIcon(str(config.RES_DIR / 'icons' / 'system' / 'voice_orb.svg')))
        random_pet_btn.setIcon(FIF.SYNC.icon())
        quit_btn.setIcon(FIF.POWER_BUTTON.icon())
        for btn in (settings_btn, chat_btn, voice_chat_btn, random_pet_btn, quit_btn):
            # 统一 30x30 纯图标按钮，语音球按钮稍大以突出主功能
            btn.setIconSize(QSize(18, 18))
            btn.setFixedSize(30, 30)
        voice_chat_btn.setIconSize(QSize(24, 24))
        settings_btn.setToolTip('设置')
        chat_btn.setToolTip('聊天')
        voice_chat_btn.setToolTip('语音球')
        voice_chat_btn.setChecked(voice_chat_active)
        random_pet_btn.setToolTip('随机切换宠物')
        quit_btn.setToolTip('退出')

        settings_btn.clicked.connect(lambda: self._trigger(on_settings))
        chat_btn.clicked.connect(lambda: self._trigger(on_chat))
        voice_chat_btn.clicked.connect(lambda: self._trigger(on_voice_chat))
        random_pet_btn.clicked.connect(lambda: self._trigger(on_random_pet))
        quit_btn.clicked.connect(lambda: self._trigger(on_quit))
        row.addWidget(settings_btn)
        row.addWidget(chat_btn)
        row.addWidget(voice_chat_btn)
        row.addWidget(random_pet_btn)
        row.addWidget(quit_btn)
        outer = QHBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(card)
        self.adjustSize()
        screen = QApplication.screenAt(QPoint(int(x), int(bottom_y))) or QApplication.primaryScreen()
        area = screen.availableGeometry() if screen else None
        gap = 6
        # 定位在桌宠上方 gap 像素处，并夹取到屏幕可视区内
        target_y = int(top_y - self.height() - gap)
        start_offset = QPoint(0, 6)
        target_x = int(x - self.width() / 2)
        if area:
            target_x = max(area.left() + 4, min(target_x, area.right() - self.width() - 4))
            target_y = max(area.top() + 4, min(target_y, area.bottom() - self.height() - 4))
        end_pos = QPoint(target_x, target_y)
        self.move(end_pos + start_offset)
        self._animate_in(end_pos)
        # 4.5秒后自动关闭：快捷菜单定位为鼠标路过时的快速操作入口，停留太久反而干扰操作
        QTimer.singleShot(4500, self.close)

    def _trigger(self, callback):
        """先关菜单再执行回调。"""
        self.close()
        callback()

    def mousePressEvent(self, event):
        if event.button() == Qt.RightButton:
            # 快捷菜单可见时，右键只负责关闭。
            self.close()
            event.accept()
            return
        super().mousePressEvent(event)

    def closeEvent(self, event):
        if self._owner is not None:
            # 任意菜单关闭后，短时间内不允许快捷菜单重新打开，避免同一次点击关闭后又弹出。
            self._owner.block_quick_menu_until = time.monotonic() + 0.4
        super().closeEvent(event)

    def _animate_in(self, end_pos):
        """入场动画：位置上滑 + 透明度渐显。"""
        self.show()
        self.raise_()
        self.activateWindow()
        pos_anim = QPropertyAnimation(self, b'pos', self)
        pos_anim.setDuration(140)
        pos_anim.setStartValue(self.pos())
        pos_anim.setEndValue(end_pos)
        pos_anim.setEasingCurve(QEasingCurve.OutCubic)
        opacity_anim = QPropertyAnimation(self, b'windowOpacity', self)
        opacity_anim.setDuration(120)
        opacity_anim.setStartValue(0.0)
        opacity_anim.setEndValue(1.0)
        self.anim_group = QParallelAnimationGroup(self)
        self.anim_group.addAnimation(pos_anim)
        self.anim_group.addAnimation(opacity_anim)
        self.anim_group.start()


