# coding:utf-8
# 魔法海螺彩蛋弹窗：本地生成一句固定风格的神秘答案，
# 不再单独连接模型，避免桌宠绕过 mini-claw 内核。
import math
import time

from PySide6.QtCore import QPoint, QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QFont, QKeyEvent, QPainter, QPen, QPixmap, QRadialGradient
from PySide6.QtWidgets import QLineEdit, QPushButton

import config
from widgets.easter.base import EasterGamePopup


class MagicConchPopup(EasterGamePopup):
    """魔法海螺弹窗：提问 → 本地彩蛋答案 → 渐显答案的自绘窗口。"""

    title = '魔法海螺'
    life_ms = 0
    def __init__(self, x, y, parent=None):
        """初始化提问输入框与"问"按钮，并主动抢焦点方便直接输入。"""
        self.answer = ''
        self.question = ''
        self.ask_started_at = 0.0
        self.waiting_llm = False
        super().__init__(x, y, parent)
        self.setFixedSize(360, 360)
        self.input = QLineEdit(self)
        self.input.setAttribute(Qt.WA_MacShowFocusRect, False)
        self.input.setPlaceholderText('问海螺一个问题...')
        self.input.setGeometry(42, 274, 206, 34)
        self.input.setStyleSheet('QLineEdit{border:1px solid rgba(112,153,210,180);border-radius:14px;padding:6px 10px;background:rgba(255,255,255,230);color:#28486c;font-size:12px;} QLineEdit:focus{border:1px solid #5b91dc;}')
        self.input.returnPressed.connect(self.ask)
        self.button = QPushButton('问', self)
        self.button.setGeometry(256, 274, 58, 34)
        self.button.setCursor(Qt.PointingHandCursor)
        self.button.setStyleSheet('QPushButton{border:none;border-radius:14px;background:#5f92dc;color:white;font-weight:700;} QPushButton:hover{background:#4d82ce;}')
        self.button.clicked.connect(self.ask)
        self.input.show()
        self.button.show()
        self.input.setFocus(Qt.OtherFocusReason)
        self.activateWindow()

    def ask(self):
        """发起提问：隐藏输入控件并展示本地彩蛋答案。"""
        question = self.input.text().strip()
        if not question:
            return
        self._play_sound('mystic')
        self.question = question
        self.answer = ''
        self.ask_started_at = time.monotonic()
        self.waiting_llm = False
        self.input.hide()
        self.button.hide()
        self.answer = '海螺说：先做眼前最重要的一步。'
        self.update()

    def _answer_ready(self, ok, text):
        """兼容旧版调用的结果整理入口。"""
        result = (text or '').strip().replace('\n', ' ')
        if ok and result:
            self.answer = result[:48]
        elif ok:
            self.answer = '海螺说：答案正在风里。'
        else:
            self.answer = ('海螺说：先听听自己的心。' + (result or ''))[:96]
        self.waiting_llm = False
        self.update()

    def keyPressEvent(self, event: QKeyEvent):
        """Esc 直接关闭弹窗。"""
        if event.key() == Qt.Key_Escape:
            self.close()
            event.accept()
            return
        super().keyPressEvent(event)

    def paintEvent(self, event):
        """整体绘制：光晕、星光、海螺，以及提问后"聆听中 → 答案渐显"两个阶段。"""
        painter = QPainter(self)
        self._draw_card(painter, QColor(238, 247, 255, 250), QColor(128, 178, 238, 230))
        elapsed = self._elapsed()
        asked = self.ask_started_at > 0.0
        ask_elapsed = time.monotonic() - self.ask_started_at if asked else 0.0
        listening = asked and (self.waiting_llm or ask_elapsed < 1.45)  # 提问后至少装 1.45s "聆听"再揭晓
        reveal = self._ease_out((ask_elapsed - 1.45) / 0.55) if asked and self.answer else 0.0  # 答案 0.55s 缓出渐显
        pulse = (math.sin(elapsed * 7) + 1) / 2
        wobble_amp = 7 if listening else 2.2
        wobble = math.sin(elapsed * 10) * wobble_amp
        cx, cy = self.width() / 2, 176 + wobble

        # 外层光晕圆圈
        painter.setPen(Qt.NoPen)
        for i in range(4):
            alpha = int((70 - i * 12) * (0.35 + pulse * 0.65))
            painter.setBrush(QColor(170, 140, 220, alpha))
            r = 62 + i * 16 + pulse * 10
            painter.drawEllipse(QPoint(int(cx), int(cy)), int(r), int(r * 0.56))
        self._draw_magic_sparkles(painter, cx, cy, elapsed, listening)
        self._draw_shell(painter, cx, cy, elapsed, listening)

        if not asked:
            return

        if listening:
            dots = '.' * (1 + int(ask_elapsed * 4) % 3)
            painter.setFont(QFont('Microsoft YaHei UI', 10, QFont.Bold))
            painter.setPen(QColor(67, 95, 142, 205))
            painter.drawText(0, 258, self.width(), 26, Qt.AlignCenter, f'海螺正在聆听宇宙的回响{dots}')
            return

        painter.setOpacity(reveal)
        painter.setPen(QPen(QColor(102, 146, 205, 150), 1))
        painter.setBrush(QColor(255, 255, 255, 226))
        box = QRectF(30, 232, self.width() - 60, 92)
        painter.drawRoundedRect(box, 15, 15)
        painter.setFont(QFont('Microsoft YaHei UI', 8))
        painter.setPen(QColor(77, 105, 145, 190))
        painter.drawText(46, 240, self.width() - 92, 18, Qt.AlignCenter, '你问：' + self.question[:24])
        painter.setPen(QColor(42, 69, 108))
        answer = self.answer
        answer_rect = QRectF(42, 262, self.width() - 84, 48)
        for size in (11, 10, 9, 8):  # 逐级缩小字号直到答案能装进文本框
            font = QFont('Microsoft YaHei UI', size, QFont.Bold)
            painter.setFont(font)
            metrics = painter.fontMetrics()
            if metrics.boundingRect(answer_rect.toRect(), Qt.AlignCenter | Qt.TextWordWrap, answer).height() <= answer_rect.height():
                break
        painter.drawText(answer_rect, Qt.AlignCenter | Qt.TextWordWrap, answer)
        painter.setOpacity(1)

    def _draw_magic_sparkles(self, painter, cx, cy, elapsed, listening):
        """简约星光粒子：只画细十字星，克制分布"""
        painter.save()
        # 6个星光点，偏移更分散
        pts = [(-78, -44), (68, -52), (104, 8), (82, 58), (-48, 62), (-96, 18)]
        for i, (dx, dy) in enumerate(pts):
            twinkle = (math.sin(elapsed * (2.8 + i * 0.45) + i * 1.3) + 1) / 2
            base_alpha = 160 if listening else 90
            alpha = int(base_alpha * (0.3 + 0.7 * twinkle))
            alpha = max(0, min(240, alpha))
            x = cx + dx + math.sin(elapsed * 1.2 + i) * 4
            y = cy + dy + math.cos(elapsed * 1.1 + i) * 3
            r = 1.4 + twinkle * 2.0
            # 十字星：两条线
            color = QColor(170, 210, 255, alpha)
            pen = QPen(color, max(1.0, r * 0.7))
            pen.setCapStyle(Qt.RoundCap)
            painter.setPen(pen)
            arm = r * 2.8
            painter.drawLine(QPointF(x - arm, y), QPointF(x + arm, y))
            painter.drawLine(QPointF(x, y - arm), QPointF(x, y + arm))
            # 斜45°短臂
            arm2 = arm * 0.55
            painter.drawLine(QPointF(x - arm2, y - arm2), QPointF(x + arm2, y + arm2))
            painter.drawLine(QPointF(x + arm2, y - arm2), QPointF(x - arm2, y + arm2))
            # 中心亮点
            painter.setPen(Qt.NoPen)
            painter.setBrush(QColor(240, 248, 255, alpha))
            painter.drawEllipse(QPointF(x, y), r * 0.6, r * 0.6)
        painter.restore()

    def _draw_shell(self, painter, cx, cy, elapsed, listening):
        """直接渲染神奇海螺图片，带摇摆和辉光动画"""
        painter.save()

        # ── 底部投影 ──
        painter.setPen(Qt.NoPen)
        sh = QRadialGradient(cx, cy + 68, 85)
        sh.setColorAt(0, QColor(160, 120, 200, 40))
        sh.setColorAt(1, QColor(160, 120, 200, 0))
        painter.setBrush(sh)
        painter.drawEllipse(QRectF(cx - 85, cy + 48, 170, 40))

        # ── 图片大小和摆动 ──
        img_size = 172  # 渲染尺寸
        sway = math.sin(elapsed * (3.2 if listening else 1.8)) * (3.0 if listening else 1.0)

        # 加载（缓存到类属性）
        if not hasattr(MagicConchPopup, '_shell_pixmap'):
            _p = config.RES_DIR / 'items' / 'easter' / 'magic_conch.png'
            MagicConchPopup._shell_pixmap = QPixmap(str(_p))

        px = MagicConchPopup._shell_pixmap
        if not px.isNull():
            scaled = px.scaled(img_size, img_size, Qt.KeepAspectRatio, Qt.SmoothTransformation)
            sw, sh2 = scaled.width(), scaled.height()
            painter.save()
            painter.translate(cx, cy)
            painter.rotate(-10 + sway)  # 固定逆时针10度 + 摇摆
            painter.drawPixmap(-sw // 2, -sh2 // 2, scaled)
            painter.restore()

        # ── 聆听时外层辉光环 ──
        if listening:
            pulse = (math.sin(elapsed * 8) + 1) / 2
            for i in range(3):
                r = img_size // 2 + 8 + i * 10 + pulse * 6
                alpha = int((80 - i * 22) * (0.5 + pulse * 0.5))
                glow = QRadialGradient(cx, cy, r)
                glow.setColorAt(0.7, QColor(200, 160, 240, alpha))
                glow.setColorAt(1.0, QColor(200, 160, 240, 0))
                painter.setPen(Qt.NoPen)
                painter.setBrush(glow)
                painter.drawEllipse(QRectF(cx - r, cy - r, r * 2, r * 2))

        painter.restore()
