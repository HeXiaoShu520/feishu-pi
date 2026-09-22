# coding:utf-8
"""桌宠轻量语音聊天悬浮球。"""

import math

from PySide6.QtCore import QEasingCurve, QEvent, QParallelAnimationGroup, QPropertyAnimation, QPoint, QPointF, QRectF, Qt, QTimer, Signal, Property
from PySide6.QtGui import QBrush, QColor, QFontMetrics, QPainter, QPen, QRadialGradient
from PySide6.QtWidgets import QApplication, QFrame, QHBoxLayout, QWidget

import config
import theme
from log_util import get_logger
from widgets.ui_utils import clamp_popup_pos

log = get_logger('voice.popup')


class VoiceOrbWidget(QWidget):
    """语音聊天状态球的绘制组件，负责动画、文字宽度和不同状态图标。"""

    width_changed = Signal()

    def __init__(self, parent=None):
        """初始化尺寸约束与动画状态；默认处于 idle 空闲态。"""
        super().__init__(parent)
        self.state = 'idle'    # 当前动画状态：idle/listening/wakeup/thinking/speaking/typing/connecting/error
        self.phase = 0         # 动画相位，由父级定时器推进
        self.text = ''         # 球内展示文本
        self.min_orb_width = 40
        self.max_orb_width = 760
        self.orb_height = 40
        self.multiline = False         # 文本超长时切多行布局
        self.icon_area_width = 40      # 左侧状态图标固定占宽
        self.text_right_padding = 12   # 文本右侧留白
        self._orb_width = self.min_orb_width
        self._target_width = self.min_orb_width
        self.width_anim = None
        # 涟漪状态（供父级 PetVoicePopup 绘制）
        self._ripples = []        # 每项为 progress float 0.0→1.0
        self._ripple_tick = 0
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setFixedSize(self.min_orb_width, self.orb_height)

    def get_orb_width(self):
        """Qt Property 读取器：返回当前球体宽度。"""
        return self._orb_width

    def set_orb_width(self, width):
        """Qt Property 写入器：夹取到合法区间后应用宽度并广播变化。"""
        width = int(max(self.min_orb_width, min(self.max_orb_width, width)))
        if self._orb_width == width:
            return
        self._orb_width = width
        self.setFixedWidth(width)
        self.width_changed.emit()
        self.update()

    orbWidth = Property(int, get_orb_width, set_orb_width)
    # 对外暴露 Qt Property 而不是直接设 width，是为了让 QPropertyAnimation 能平滑驱动宽度变化

    def set_state(self, state):
        """切换动画状态；状态变化时相位归零，让新动画从头播放。"""
        if self.state != state:
            log.info('语音球状态: %s -> %s', self.state, state)
            self.state = state
            self.phase = 0
        self.update()

    def set_text(self, text):
        """更新展示文本，并按文本内容触发球体宽度动画。"""
        self.text = str(text or '').strip()
        # 超过 35 个字符按多行文本布局（球体高度撑到 64），否则单行省略
        self.multiline = len(self.text) > 35
        self._animate_to_text_width()
        self.update()

    def set_initial_content(self, state, text):
        """重置状态和尺寸，确保上一轮宽度动画不会残留。"""
        self.state = state
        self.phase = 0
        self.text = str(text or '').strip()
        self.multiline = len(self.text) > 35
        if self.width_anim is not None:
            self.width_anim.stop()
            self.width_anim = None
        self.setFixedHeight(64 if self.multiline else self.orb_height)
        self._target_width = self._text_target_width(self.text)
        self._orb_width = self._target_width
        self.setFixedWidth(self._target_width)
        self.update()

    def set_phase(self, phase):
        """由父级定时器驱动相位，控制波形/脉冲类动画的推进。"""
        self.phase = phase
        self.update()

    def _tick_ripples(self):
        # 推进所有涟漪，progress 0.0→1.0
        self._ripples = [p + 0.022 for p in self._ripples if p + 0.022 < 1.0]
        # listening/speaking/wakeup 状态每隔一定 tick 生成新涟漪，最多同时 3 个
        if self.state in ('listening', 'speaking', 'wakeup', 'typing'):
            self._ripple_tick += 1
            interval = 28 if self.state == 'wakeup' else (22 if self.state == 'listening' else 18)
            if self._ripple_tick >= interval and len(self._ripples) < 3:
                self._ripples.append(0.0)
                self._ripple_tick = 0
        else:
            self._ripple_tick = 0

    def _text_font(self):
        """构建球内文字使用的统一字体（雅黑 10pt）。"""
        font = self.font()
        font.setPointSize(10)
        font.setFamily('Microsoft YaHei UI')
        return font

    def _text_target_width(self, text):
        """根据文本计算球体目标宽度：图标区 + 文本宽 + 右侧留白。"""
        if not text:
            return self.min_orb_width
        fm = QFontMetrics(self._text_font())
        if len(text) > 35:
            # 多行文本：只按第一行 35 字符估宽，限制在 [220, 680] 内避免球体过宽
            return self.icon_area_width + 8 + min(680, max(220, fm.horizontalAdvance(text[:35]))) + self.text_right_padding
        target = self.icon_area_width + 8 + fm.horizontalAdvance(text) + self.text_right_padding
        return max(self.min_orb_width, min(self.max_orb_width, target))

    def _animate_to_text_width(self):
        # 文字变短时用较慢动画（220ms），避免收缩过快导致文字被截断后才消失的视觉跳变
        target = self._text_target_width(self.text)
        if abs(target - self._target_width) < 2:
            return
        self._target_width = target
        if self.width_anim is not None:
            self.width_anim.stop()
        self.width_anim = QPropertyAnimation(self, b'orbWidth', self)
        self.width_anim.setDuration(220 if target <= self.min_orb_width else 180)
        self.width_anim.setStartValue(self._orb_width)
        self.width_anim.setEndValue(target)
        self.width_anim.setEasingCurve(QEasingCurve.InOutCubic if target <= self.min_orb_width else QEasingCurve.OutCubic)
        self.width_anim.start()

    def paintEvent(self, event):
        """绘制胶囊底色、材质高光、状态图标和文本。"""
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        pill = QRectF(self.rect()).adjusted(1, 1, -1, -1)
        bg, border = self._background_colors()
        painter.setPen(QPen(border, 1))
        painter.setBrush(QBrush(bg))
        painter.drawRoundedRect(pill, pill.height() / 2, pill.height() / 2)
        self._paint_material_glow(painter, pill)

        icon_rect = QRectF(0, 0, self.icon_area_width, self.height()).adjusted(4, 4, -4, -4)
        if self.state == 'listening':
            self._paint_listening(painter, icon_rect)
        elif self.state == 'wakeup':
            self._paint_wakeup(painter, icon_rect)
        elif self.state == 'thinking':
            self._paint_thinking(painter, icon_rect)
        elif self.state == 'speaking':
            self._paint_speaking(painter, icon_rect)
        elif self.state == 'typing':
            self._paint_typing(painter, icon_rect)
        elif self.state == 'connecting':
            self._paint_connecting(painter, icon_rect)
        elif self.state == 'error':
            self._paint_status_dot(painter, icon_rect, QColor(255, 90, 80, 220))
        else:
            self._paint_status_dot(painter, icon_rect, self._color('dot', 185))
        self._paint_text(painter)

    def _paint_material_glow(self, painter, pill):
        """叠加拟物质感：左上角径向高光渐变 + 顶部弧形反光线 + 内描边。"""
        t = theme.current_theme()
        glow_colors = t.get('orb_glow', ((255, 255, 255, 112), (215, 245, 235, 52)))
        c0 = QColor(*glow_colors[0])
        c1 = QColor(*glow_colors[1])
        c2 = QColor(c1.red(), c1.green(), c1.blue(), 18)
        inner = QColor(c1.red(), c1.green(), c1.blue(), 40)
        glow = QRadialGradient(QPointF(pill.left() + pill.width() * 0.28, pill.top() + pill.height() * 0.26), max(pill.width(), pill.height()) * 0.78)
        glow.setColorAt(0.0, c0)
        glow.setColorAt(0.45, c1)
        glow.setColorAt(1.0, c2)
        painter.setPen(Qt.NoPen)
        painter.setBrush(QBrush(glow))
        painter.drawRoundedRect(pill.adjusted(2, 2, -2, -2), pill.height() / 2, pill.height() / 2)

        painter.setPen(QPen(QColor(255, 255, 255, 86), 1.2))
        painter.setBrush(Qt.NoBrush)
        painter.drawArc(pill.adjusted(7, 6, -7, -7), 42 * 16, 92 * 16)
        painter.setPen(QPen(inner, 1))
        painter.drawRoundedRect(pill.adjusted(3, 3, -3, -3), pill.height() / 2 - 3, pill.height() / 2 - 3)

    def _palette(self):
        """取当前主题的 orb 配色字典。"""
        return theme.current_theme()['orb']

    def _color(self, key, alpha=None):
        """按 key 取主题色；三元素元组补充 alpha，四元素元组可覆盖 alpha。"""
        values = self._palette()[key]
        if len(values) == 3:
            values = (*values, 255 if alpha is None else alpha)
        elif alpha is not None:
            values = (*values[:3], alpha)
        return QColor(*values)

    def _background_colors(self):
        """按状态返回 (背景色, 边框色)：错误和输入态使用特殊边框色提醒用户。"""
        if self.state == 'error':
            return QColor(255, 244, 244, 245), QColor(255, 150, 140, 235)
        if self.state == 'typing':
            return self._color('bg'), QColor(255, 130, 110, 235)
        if self.state == 'idle':
            return self._color('bg'), self._color('border')
        if self.state == 'wakeup':
            return self._color('bg'), self._color('ring', 245)
        return self._color('bg'), self._color('border')

    def _paint_text(self, painter):
        """绘制文本：多行自动换行，单行超出宽度时右侧省略。"""
        if not self.text or self.width() <= self.icon_area_width + 10:
            return
        text_rect = QRectF(self.icon_area_width, 0, self.width() - self.icon_area_width - self.text_right_padding, self.height())
        if text_rect.width() <= 8:
            return
        painter.setPen(self._color('text'))
        font = self._text_font()
        painter.setFont(font)
        if self.multiline:
            painter.drawText(text_rect, Qt.AlignVCenter | Qt.AlignLeft | Qt.TextWordWrap, self.text)
        else:
            text = QFontMetrics(font).elidedText(self.text, Qt.ElideRight, int(text_rect.width()))
            painter.drawText(text_rect, Qt.AlignVCenter | Qt.AlignLeft, text)

    def _paint_listening(self, painter, rect):
        """绘制 5 根随正弦波起伏的音柱，模拟拾音中的声波动效。"""
        center_y = rect.center().y()
        bar_count = 5
        bar_w = 3.6
        gap = 2.8
        total_w = bar_count * bar_w + (bar_count - 1) * gap
        start_x = rect.center().x() - total_w / 2
        color = self._color('wave')
        painter.setPen(Qt.NoPen)
        painter.setBrush(QBrush(color))
        for i in range(bar_count):
            # 每根柱错开相位 2，形成波浪滚动效果
            wave = (math.sin((self.phase + i * 2) * 0.65) + 1) / 2
            height = 7 + wave * 13
            x = start_x + i * (bar_w + gap)
            y = center_y - height / 2
            painter.drawRoundedRect(QRectF(x, y, bar_w, height), 2, 2)

    def _paint_wakeup(self, painter, rect):
        """唤醒态：呼吸圆环 + 旋转残缺弧 + 双层核心光点。"""
        center = rect.center()
        pulse = (math.sin(self.phase * 0.42) + 1) / 2
        outer_radius = 12 + pulse * 3
        painter.setPen(QPen(self._color('ring', 120 - int(pulse * 45)), 2.0))
        painter.setBrush(Qt.NoBrush)
        painter.drawEllipse(QRectF(center.x() - outer_radius, center.y() - outer_radius, outer_radius * 2, outer_radius * 2))
        painter.setPen(QPen(self._color('wave', 210), 2.3))
        arc_rect = QRectF(center.x() - 8.5, center.y() - 8.5, 17, 17)
        start = int((self.phase * 18) % 360) * 16
        painter.drawArc(arc_rect, start, 250 * 16)
        painter.setPen(Qt.NoPen)
        painter.setBrush(QBrush(self._color('core')))
        painter.drawEllipse(QRectF(center.x() - 4.2, center.y() - 4.2, 8.4, 8.4))
        painter.setBrush(QBrush(self._color('core2')))
        painter.drawEllipse(QRectF(center.x() - 1.8, center.y() - 1.8, 3.6, 3.6))

    def _paint_thinking(self, painter, rect):
        """思考态：三个圆点错相位呼吸缩放，模拟“正在输入”指示。"""
        painter.setPen(Qt.NoPen)
        base_x = rect.center().x() - 10
        y = rect.center().y()
        for i in range(3):
            pulse = (math.sin((self.phase + i * 4) * 0.55) + 1) / 2
            radius = 2.8 + pulse * 1.6
            alpha = 95 + int(pulse * 125)
            painter.setBrush(QBrush(self._color('dot', alpha)))
            cx = base_x + i * 10
            painter.drawEllipse(QRectF(cx - radius, y - radius, radius * 2, radius * 2))

    def _paint_speaking(self, painter, rect):
        """播放态：扩散呼吸圆环 + 双层核心亮斑，呼应 TTS 播报。"""
        center = rect.center()
        pulse = (math.sin(self.phase * 0.45) + 1) / 2
        ring_radius = 8 + pulse * 6
        ring_alpha = 95 - int(pulse * 55)
        painter.setPen(QPen(self._color('ring', ring_alpha), 2.0))
        painter.setBrush(Qt.NoBrush)
        painter.drawEllipse(QRectF(center.x() - ring_radius, center.y() - ring_radius, ring_radius * 2, ring_radius * 2))

        painter.setPen(Qt.NoPen)
        painter.setBrush(QBrush(self._color('core')))
        painter.drawEllipse(QRectF(center.x() - 5.5, center.y() - 5.5, 11, 11))
        painter.setBrush(QBrush(self._color('core2')))
        painter.drawEllipse(QRectF(center.x() - 2.8, center.y() - 2.8, 5.6, 5.6))
        painter.setBrush(QBrush(QColor(255, 255, 246, 170)))
        painter.drawEllipse(QRectF(center.x() - 3.5, center.y() - 5.0, 3.2, 3.2))

    def _paint_typing(self, painter, rect):
        """语音输入态：3 根红色系音柱，与 listening 蓝绿波区分。"""
        center_y = rect.center().y()
        bar_count = 3
        bar_w = 3.5
        gap = 3.5
        total_w = bar_count * bar_w + (bar_count - 1) * gap
        start_x = rect.center().x() - total_w / 2
        painter.setPen(Qt.NoPen)
        for i in range(bar_count):
            wave = (math.sin((self.phase + i * 3) * 0.65) + 1) / 2
            height = 6 + wave * 12
            alpha = 180 + int(wave * 55)
            painter.setBrush(QBrush(QColor(255, 85, 75, alpha)))
            x = start_x + i * (bar_w + gap)
            y = center_y - height / 2
            painter.drawRoundedRect(QRectF(x, y, bar_w, height), 1.8, 1.8)

    def _paint_connecting(self, painter, rect):
        """连接中态：琥珀色旋转弧线 + 呼吸圆点，表示握手进行中、还不能识别。"""
        center = rect.center()
        color = QColor(255, 170, 60)
        painter.setPen(QPen(color, 2.3, Qt.SolidLine, Qt.RoundCap))
        painter.setBrush(Qt.NoBrush)
        arc_rect = QRectF(center.x() - 8.5, center.y() - 8.5, 17, 17)
        start = int((self.phase * 30) % 360) * 16
        painter.drawArc(arc_rect, start, 260 * 16)
        pulse = (math.sin(self.phase * 0.5) + 1) / 2
        dot = QColor(color)
        dot.setAlpha(120 + int(pulse * 110))
        painter.setPen(Qt.NoPen)
        painter.setBrush(QBrush(dot))
        radius = 3.0 + pulse * 1.2
        painter.drawEllipse(QRectF(center.x() - radius, center.y() - radius, radius * 2, radius * 2))

    def _paint_status_dot(self, painter, rect, color):
        """兜底绘制：以指定颜色画一个实心状态圆点。"""
        painter.setPen(Qt.NoPen)
        painter.setBrush(QBrush(color))
        radius = 5
        center = rect.center()
        painter.drawEllipse(QRectF(center.x() - radius, center.y() - radius, radius * 2, radius * 2))


class PetVoicePopup(QFrame):
    """跟随桌宠移动的轻量语音聊天悬浮球。"""

    pause_requested = Signal()
    stop_requested = Signal()

    def __init__(self, x, y, parent=None, anchor_mode='pet', initial_state='idle', initial_text=''):
        """初始化悬浮球；anchor_mode 决定定位基准（'pet' 贴桌宠 / 'cursor' 贴光标）。"""
        super().__init__(parent)
        self.anim_group = None
        self.follow_anim = None
        self.follow_target = None
        self.follow_pos = QPointF()
        self.follow_velocity = QPointF()
        self.follow_timer = QTimer(self)
        self.follow_timer.timeout.connect(self._spring_follow_step)
        self.state = initial_state
        self.anchor_x = x
        self.anchor_y = y
        self.anchor_mode = anchor_mode
        self.anim_index = 0
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool | Qt.NoDropShadowWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setWindowOpacity(1.0)
        self.setStyleSheet('''
            QFrame#VoiceCard {
                border: none;
                background: transparent;
            }
            QLabel { border: none; background: transparent; color: #202124; font-family: "Microsoft YaHei UI", "Microsoft YaHei"; }
        ''')
        card = QFrame(self)
        card.setObjectName('VoiceCard')
        # 内层卡片承载球体，外层窗口保持透明以扩大点击与涟漪绘制区域
        root = QHBoxLayout(card)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        self.anim_widget = VoiceOrbWidget(card)
        self.anim_widget.set_initial_content(initial_state, initial_text)
        self.anim_widget.installEventFilter(self)
        self.anim_widget.width_changed.connect(self._sync_to_current_anchor)
        self.anim_widget.setToolTip('单击暂停/继续语音，双击结束语音聊天')
        root.addWidget(self.anim_widget)

        outer = QHBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(card)
        self.adjustSize()
        end_pos = self._pos_from_anchor(x, y)
        self.follow_pos = QPointF(end_pos)
        self.follow_target = end_pos
        self.move(end_pos + QPoint(0, 8))
        self._animate_in(end_pos)
        # 单击/双击区分定时器：超时未等来双击则判定为单击暂停
        self.click_timer = QTimer(self)
        self.click_timer.setSingleShot(True)
        self.click_timer.timeout.connect(self.pause_requested.emit)
        # 动画心跳定时器：120ms/帧，兼顾流畅度与 CPU 占用
        self.anim_timer = QTimer(self)
        self.anim_timer.timeout.connect(self._tick_animation)
        self.anim_timer.start(120)

    def eventFilter(self, watched, event):
        """拦截球体鼠标事件：用单击定时器区分单击暂停与双击结束，避免误触发。"""
        if watched is self.anim_widget:
            if event.type() == QEvent.MouseButtonDblClick and event.button() == Qt.LeftButton:
                self.click_timer.stop()
                self.stop_requested.emit()
                event.accept()
                return True
            if event.type() == QEvent.MouseButtonPress and event.button() == Qt.LeftButton:
                self.click_timer.start(QApplication.doubleClickInterval())
                event.accept()
                return True
            if event.type() == QEvent.MouseButtonRelease and event.button() == Qt.LeftButton:
                event.accept()
                return True
        return super().eventFilter(watched, event)

    def _pos_from_anchor(self, x, y):
        """由锚点坐标计算弹窗应出现的位置，结果始终夹取到屏幕可视区内。"""
        anchor = QPoint(int(x), int(y))
        if self.anchor_mode == 'cursor':
            screen = QApplication.screenAt(anchor) or QApplication.primaryScreen()
            area = screen.availableGeometry() if screen else None
            gap = 28
            # 默认出现在光标上方，上方空间不足时翻转到光标下方
            px = int(x - self.width() / 2)
            py = int(y - self.height() - gap)
            if area is not None and py < area.top() + 4:
                py = int(y + gap)
            return clamp_popup_pos(QPoint(px, py), self.size(), anchor)

        side_overlap = 8
        # pet 模式：基于桌宠实际可见像素边界，把球体贴到桌宠左右肩位置
        parent = self.parent()
        bounds = parent._current_visible_bounds() if hasattr(parent, '_current_visible_bounds') else None
        if bounds is not None:
            pet_left = parent.x() + parent.label.x() + bounds.left()
            pet_right = parent.x() + parent.label.x() + bounds.right()
            pet_top = parent.y() + parent.label.y() + bounds.top()
            pet_height = bounds.height()
            screen = QApplication.screenAt(anchor) or QApplication.primaryScreen()
            area = screen.availableGeometry() if screen else None
            prefer_right = area is None or pet_right - side_overlap + self.width() <= area.right()
            px = int(pet_right - side_overlap) if prefer_right else int(pet_left - self.width() + side_overlap)
            py = int(pet_top + pet_height * 0.06)
            return clamp_popup_pos(QPoint(px, py), self.size(), anchor)
        px = int(x - side_overlap)
        return clamp_popup_pos(QPoint(px, int(y - self.height() / 2)), self.size(), anchor)

    def move_to_anchor(self, x, y, smooth=True, floaty=False, anchor_mode=None):
        """更新锚点并按配置的跟随效果（magnet/spring）移动悬浮球。"""
        # 提供两种跟随效果：magnet（缓动曲线，适合大幅跳跃）和 spring（弹簧物理，适合连续跟随）
        # 选择由 voice_follow_effect 配置控制，不在此处硬编码
        self.anchor_x = x
        self.anchor_y = y
        if anchor_mode is not None:
            self.anchor_mode = anchor_mode
        self.follow_floaty = floaty
        target = self._pos_from_anchor(x, y)
        self.follow_target = target
        if not smooth:
            self.follow_timer.stop()
            if self.follow_anim is not None:
                self.follow_anim.stop()
            self.follow_pos = QPointF(target)
            self.follow_velocity = QPointF()
            self.move(target)
            return
        effect = config.app_config.get('voice_follow_effect', 'spring')
        if effect == 'magnet':
            self.follow_timer.stop()
            self.follow_velocity = QPointF()
            if self.follow_anim is not None:
                self.follow_anim.stop()
            distance = abs(target.x() - self.x()) + abs(target.y() - self.y())
            level = config.app_config.get('voice_follow_level', 'normal')
            magnet_params = {
                'soft': (110, 240, 0.75),
                'normal': (80, 180, 0.55),
                'fast': (55, 130, 0.38),
            }
            min_ms, max_ms, factor = magnet_params.get(level, magnet_params['normal'])
            duration = max(min_ms, min(max_ms, int(distance * factor)))
            self.follow_anim = QPropertyAnimation(self, b'pos', self)
            self.follow_anim.setDuration(duration)
            self.follow_anim.setStartValue(self.pos())
            self.follow_anim.setEndValue(target)
            self.follow_anim.setEasingCurve(QEasingCurve.OutExpo)
            self.follow_anim.finished.connect(lambda: setattr(self, 'follow_pos', QPointF(self.pos())))
            self.follow_anim.start()
            return
        if self.follow_anim is not None:
            self.follow_anim.stop()
        if self.follow_pos.isNull():
            self.follow_pos = QPointF(self.pos())
        if not self.follow_timer.isActive():
            self.follow_timer.start(16)

    def _spring_follow_step(self):
        """弹簧跟随的单帧步进：加速度正比于距离，速度按阻尼衰减。"""
        if self.follow_target is None:
            self.follow_timer.stop()
            return
        target = QPointF(self.follow_target)
        dx = target.x() - self.follow_pos.x()
        dy = target.y() - self.follow_pos.y()
        if abs(dx) < 0.5 and abs(dy) < 0.5 and abs(self.follow_velocity.x()) < 0.5 and abs(self.follow_velocity.y()) < 0.5:
            self.follow_pos = target
            self.follow_velocity = QPointF()
            self.move(self.follow_target)
            self.follow_timer.stop()
            return
        level = config.app_config.get('voice_follow_level', 'normal')
        spring_params = {
            'soft': (0.10, 0.88),
            'normal': (0.16, 0.82),
            'fast': (0.24, 0.76),
        }
        stiffness, damping = spring_params.get(level, spring_params['normal'])
        # 半隐式欧拉积分：先更新速度再更新位置，数值上更稳定
        self.follow_velocity.setX((self.follow_velocity.x() + dx * stiffness) * damping)
        self.follow_velocity.setY((self.follow_velocity.y() + dy * stiffness) * damping)
        self.follow_pos.setX(self.follow_pos.x() + self.follow_velocity.x())
        self.follow_pos.setY(self.follow_pos.y() + self.follow_velocity.y())
        self.move(QPoint(round(self.follow_pos.x()), round(self.follow_pos.y())))

    def _sync_to_current_anchor(self):
        """宽度动画改变尺寸后，立即重新对齐锚点（不平滑，避免漂移）。"""
        self.adjustSize()
        self.move_to_anchor(self.anchor_x, self.anchor_y, smooth=False)

    def _animate_in(self, end_pos):
        """首次显示：从锚点下方 8px 处滑入到目标位置。"""
        self.show()
        self.raise_()
        self.setWindowOpacity(1.0)
        pos_anim = QPropertyAnimation(self, b'pos', self)
        pos_anim.setDuration(160)
        pos_anim.setStartValue(self.pos())
        pos_anim.setEndValue(end_pos)
        pos_anim.setEasingCurve(QEasingCurve.OutCubic)
        self.anim_group = QParallelAnimationGroup(self)
        self.anim_group.addAnimation(pos_anim)
        self.anim_group.start()

    def update_state(self, state, text=''):
        """统一的状态更新入口：同步动画状态、文本、位置和悬浮提示。"""
        self.state = state
        self.anim_widget.set_state(state)
        self.anim_widget.set_text(text)
        self._sync_to_current_anchor()
        tips = {
            'listening': '正在听你说话',
            'thinking': '正在思考',
            'speaking': '正在播放回复',
            'wakeup': '等待唤醒词',
            'idle': '语音聊天已结束',
            'error': '语音聊天出错',
            'typing': '语音输入中',
        }
        tip = tips.get(state, '语音聊天')
        if text:
            tip = f'{tip}：{str(text)[:30]}'
        self.setToolTip(tip)

    def _tick_animation(self):
        """120ms 一帧的动画心跳：推进相位与涟漪，触发重绘。"""
        self.anim_index = (self.anim_index + 1) % 24
        self.anim_widget.set_phase(self.anim_index)
        self.anim_widget._tick_ripples()
        self.update()  # 触发 PetVoicePopup.paintEvent 绘制涟漪

    def mousePressEvent(self, event):
        """非球体区域（边距）上的单击同样走暂停逻辑。"""
        if event.button() == Qt.LeftButton:
            self.click_timer.start(QApplication.doubleClickInterval())
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseDoubleClickEvent(self, event):
        """双击结束语音聊天，与 eventFilter 中的球体双击行为一致。"""
        if event.button() == Qt.LeftButton:
            self.click_timer.stop()
            self.stop_requested.emit()
            event.accept()
            return
        super().mouseDoubleClickEvent(event)

    def paintEvent(self, event):
        # 涟漪圈绘制在 PetVoicePopup 而非 VoiceOrbWidget，
        # 原因：涟漪半径超出 orb 边界，需要用顶层窗口坐标系作画
        ripples = self.anim_widget._ripples
        if not ripples:
            return
        orb = self.anim_widget
        # orb 相对于 popup 的位置
        orb_pos = orb.mapTo(self, QPoint(0, 0))
        cx = orb_pos.x() + orb.width() / 2
        cy = orb_pos.y() + orb.height() / 2
        orb_r = orb.orb_height / 2 - 1
        max_extra = orb_r * 1.6  # 涟漪最大扩散半径为球体半径的 1.6 倍
        ring_color = orb._color('ring')
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        painter.setBrush(Qt.NoBrush)
        for t in ripples:
            radius = orb_r + t * max_extra
            alpha = int((1.0 - t) ** 2 * 80)
            if alpha <= 0:
                continue
            color = QColor(ring_color.red(), ring_color.green(), ring_color.blue(), alpha)
            pen_w = 2.0 * (1.0 - t * 0.5)
            painter.setPen(QPen(color, pen_w))
            painter.drawEllipse(QRectF(cx - radius, cy - radius, radius * 2, radius * 2))
        painter.end()

    def closeEvent(self, event):
        """窗口关闭时回收定时器等资源。"""
        # 窗口关闭时务必停止所有定时器，防止 C++ 层对象已销毁后 Python 回调仍触发
        self.click_timer.stop()
        self.anim_timer.stop()
        super().closeEvent(event)


