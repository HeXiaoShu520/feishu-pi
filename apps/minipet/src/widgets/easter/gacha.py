# coding:utf-8
# 扭蛋机彩蛋：点击按钮启动动画，等待胶囊掉落后点击开出今日奖励。
# 奖励在 start_gacha 时随机确定，保证同一次动画不会在中途换奖品。
import math
import random
import time

from PySide6.QtCore import QPoint, Qt
from PySide6.QtGui import QColor, QFont, QLinearGradient, QPainter, QPen
from PySide6.QtWidgets import QPushButton

from widgets.easter.base import EasterGamePopup


class GachaPopup(EasterGamePopup):
    """桌宠扭蛋机彩蛋弹窗：QPainter 绘制扭蛋机旋转/落胶囊动画，点击胶囊开出奖品。"""

    title = '桌宠扭蛋机'

    # 奖池：(奖品标题, 奖品文案)，抽取时均匀随机
    PRIZES = [
        ('🌸 今日一句', '今天会遇见一件小好事。'),
        ('🌸 今日一句', '代码一次跑通的概率今天翻倍。'),
        ('🌸 今日一句', '今天写的注释会被未来的你感谢。'),
        ('🍀 今日好运', '幸运值 87%，适合提交代码。'),
        ('🍀 今日好运', '今天的 Bug 都是表面问题，好修。'),
        ('🍀 今日好运', '遇到的报错都能在前三条搜索结果里找到答案。'),
        ('🚀 今日 BUFF', '写代码效率 +20%，但只持续到下班。'),
        ('🚀 今日 BUFF', '思路清晰 +50%，逻辑顺畅加成。'),
        ('🚀 今日 BUFF', '专注力 MAX，摸鱼欲望 -80%。'),
        ('🚀 今日 BUFF', '代码补全准确率 +30%，少打好多字。'),
        ('😴 今日 Debuff', '容易犯困，记得补水和休息。'),
        ('😴 今日 Debuff', '容易手滑打错变量名，小心拼写。'),
        ('😴 今日 Debuff', '今天可能遇到玄学问题，保持耐心。'),
        ('✨ 随机表情', '( •̀ ω •́ )✧'),
        ('✨ 随机表情', '(｡•̀ᴗ-)✧'),
        ('✨ 随机表情', '(๑•̀ㅂ•́)و✧'),
        ('✨ 随机表情', 'ヾ(≧▽≦*)o'),
        ('✨ 随机表情', '(๑˃ᴗ˂)ﻭ'),
        ('🎯 小任务', '把那个一直拖着的小功能做完。'),
        ('🎯 小任务', '整理一下待办列表，删掉过期的。'),
        ('🎯 小任务', '给最近的提交写个像样的 commit message。'),
        ('🎯 小任务', '把上周说要优化的地方优化一下。'),
        ('💡 灵感降临', '突然想到一个优雅的实现方案。'),
        ('💡 灵感降临', '今天适合重构，思路会很清晰。'),
        ('🎁 随机奖励', '获得一次免费摸鱼机会（限今日）。'),
        ('🎁 随机奖励', '今天写的代码可以少测一轮（不推荐）。'),
        ('🔧 开发者贴士', '记得定期提交，别攒到最后。'),
        ('🔧 开发者贴士', '先写测试再写代码，会更快。'),
        ('🔧 开发者贴士', '卡住超过 15 分钟就该求助了。'),
        ('📦 神秘物品', '获得了一个万能的 console.log。'),
        ('📦 神秘物品', '获得了传说中的「一次跑通」护身符。'),
    ]

    def __init__(self, x, y, parent=None):
        """预抽奖品并初始化"开始扭蛋"按钮。"""
        self.prize = random.choice(self.PRIZES)
        self.opened = False
        self.started = False
        super().__init__(x, y, parent)
        self.setFixedSize(300, 360)
        self.start_button = QPushButton('开始扭蛋', self)
        self.start_button.setGeometry(104, 306, 92, 34)
        self.start_button.setCursor(Qt.PointingHandCursor)
        self.start_button.setStyleSheet('QPushButton{border:none;border-radius:15px;background:#ef5c91;color:white;font-weight:800;} QPushButton:hover{background:#dc477f;}')
        self.start_button.clicked.connect(self.start_gacha)
        self.start_button.show()

    def start_gacha(self):
        # 重置动画状态并重新随机奖品，允许玩家反复扭，每次都是新的一抽
        self.started = True
        self.opened = False
        self.prize = random.choice(self.PRIZES)
        self.started_at = time.monotonic()
        self.played_sounds.clear()
        self.start_button.hide()
        self.update()

    def mouseReleaseEvent(self, event):
        """胶囊落定（动画 2 秒后）左键点击即打开胶囊展示奖品。"""
        # 动画开始 2 秒后胶囊才落到位，点击才有效，防止用户点空触发误操作
        if self.started and event.button() == Qt.LeftButton and self._elapsed() >= 2.0:
            self.opened = True
            self.update()
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def paintEvent(self, event):
        """逐帧绘制扭蛋机：机身 → 玻璃罩 → 彩蛋 → 旋钮 → 胶囊/结果卡片。"""
        painter = QPainter(self)
        self._draw_card(painter, QColor(255, 247, 252, 250), QColor(238, 177, 210, 230))
        elapsed = self._elapsed() if self.started else 0.0
        if self.started:
            self._play_once("gacha_turn", "tick")  # 旋转开始时的咔哒声
            if elapsed > 1.05:
                self._play_once("gacha_drop", "drop")
            if self.opened:
                self._play_once("gacha_open", "open")
        # turn_p：机器旋转进度；drop_p：胶囊下落进度；shake：机身左右抖动偏移
        # 各动画阶段串联：先旋转（0~1.1s）→ 胶囊落下（1.05~1.9s）→ 等待点击开
        turn_p = min(1.0, elapsed / 1.1) if self.started else 0.0
        drop_p = self._ease_out((elapsed - 1.05) / 0.85) if self.started else 0.0
        shake = math.sin(elapsed * 38) * 3 * (1 - turn_p) if self.started and elapsed < 1.1 else 0

        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor(95, 55, 88, 35))
        painter.drawEllipse(74, 284, 152, 18)  # 机身投地阴影

        body_grad = QLinearGradient(74, 76, 226, 266)
        body_grad.setColorAt(0, QColor(255, 184, 215))
        body_grad.setColorAt(0.55, QColor(255, 126, 181))
        body_grad.setColorAt(1, QColor(201, 77, 132))
        painter.setBrush(body_grad)
        painter.setPen(QPen(QColor(166, 82, 124), 2))
        painter.drawRoundedRect(74 + shake, 76, 152, 190, 22, 22)
        glass_grad = QLinearGradient(92, 92, 208, 184)
        glass_grad.setColorAt(0, QColor(255, 255, 255, 230))
        glass_grad.setColorAt(1, QColor(255, 224, 243, 180))
        painter.setBrush(glass_grad)
        painter.drawRoundedRect(92 + shake, 92, 116, 92, 18, 18)  # 玻璃罩，随机身一起抖动
        painter.setPen(QPen(QColor(255, 255, 255, 150), 2))
        painter.drawArc(104 + int(shake), 101, 84, 50, 35 * 16, 95 * 16)
        painter.setPen(QPen(QColor(166, 82, 124), 2))
        painter.setBrush(QColor(238, 92, 145))
        painter.drawRoundedRect(96 + shake, 196, 108, 42, 16, 16)  # 出蛋口面板
        painter.setBrush(QColor(255, 249, 253))
        painter.drawRoundedRect(112 + shake, 210, 76, 16, 8, 8)

        colors = [QColor(255, 211, 91), QColor(117, 205, 255), QColor(155, 229, 131), QColor(195, 143, 255), QColor(255, 142, 142)]
        for i, color in enumerate(colors):
            bx = 112 + (i % 3) * 32 + math.sin(elapsed * 5 + i) * 3 + shake
            by = 126 + (i // 3) * 27 + math.cos(elapsed * 4 + i) * 2
            painter.setBrush(color)
            painter.setPen(QPen(QColor(255, 255, 255, 150), 1))
            # 彩蛋随时间轻微正弦浮动，营造玻璃罩内堆放的自然感
            painter.drawEllipse(QPoint(int(bx), int(by)), 15, 15)

        painter.save()
        painter.translate(150 + shake, 197)
        painter.rotate(360 * self._ease_out(turn_p))  # 旋钮随动画转满一圈后缓停
        painter.setBrush(QColor(255, 230, 118))
        painter.setPen(QPen(QColor(154, 105, 28), 2))
        painter.drawEllipse(QPoint(0, 0), 25, 25)
        painter.setPen(QPen(QColor(154, 105, 28), 4, Qt.SolidLine, Qt.RoundCap))
        painter.drawLine(-13, 0, 13, 0)
        painter.restore()

        # 胶囊：上半透明蓝、下半黄色，随 drop_p 从玻璃罩落到底部出口
        cap_x = 150
        cap_y = 182 + 88 * drop_p
        if drop_p > 0:
            painter.setPen(QPen(QColor(137, 76, 105), 1.5))
            painter.setBrush(QColor(119, 205, 255))
            painter.drawPie(int(cap_x - 24), int(cap_y - 24), 48, 48, 0, 180 * 16)
            painter.setBrush(QColor(255, 232, 116))
            painter.drawPie(int(cap_x - 24), int(cap_y - 24), 48, 48, 180 * 16, 180 * 16)
            painter.drawLine(int(cap_x - 24), int(cap_y), int(cap_x + 24), int(cap_y))

        if not self.started:
            painter.setFont(QFont('Microsoft YaHei UI', 10, QFont.Bold))
            painter.setPen(QColor(126, 62, 98, 205))
            painter.drawText(0, 270, self.width(), 24, Qt.AlignCenter, '点击按钮开始')
            return

        if elapsed < 2.0:
            painter.setFont(QFont('Microsoft YaHei UI', 10, QFont.Bold))
            painter.setPen(QColor(126, 62, 98, 205))
            text = '咔哒咔哒，扭蛋掉落中...' if elapsed < 1.9 else '点击胶囊打开'
            painter.drawText(0, 306, self.width(), 24, Qt.AlignCenter, text)
            return

        if not self.opened:
            painter.setFont(QFont('Microsoft YaHei UI', 10, QFont.Bold))
            painter.setPen(QColor(126, 62, 98, 220))
            painter.drawText(0, 306, self.width(), 24, Qt.AlignCenter, '点击胶囊打开')
            return

        title, text = self.prize
        # 已开启：在出蛋口下方弹出白色结果卡片展示奖品
        painter.setBrush(QColor(255, 255, 255, 232))
        painter.setPen(QPen(QColor(220, 144, 188, 160), 1))
        painter.drawRoundedRect(38, 205, 224, 72, 16, 16)
        painter.setFont(QFont('Microsoft YaHei UI', 11, QFont.Bold))
        painter.setPen(QColor(136, 58, 102))
        painter.drawText(48, 212, 204, 24, Qt.AlignCenter, title)
        painter.setFont(QFont('Microsoft YaHei UI', 9))
        painter.setPen(QColor(91, 57, 78))
        painter.drawText(52, 238, 196, 30, Qt.AlignCenter | Qt.TextWordWrap, text)
