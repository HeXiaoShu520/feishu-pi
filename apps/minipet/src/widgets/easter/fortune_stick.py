# coding:utf-8
# 许愿签彩蛋：模拟实体签筒摇晃动画，2.35 秒后弹出今日运势签纸。
# 签纸内容（宜/忌）在构造时随机确定，避免重复点击刷新结果，保持"今日只此一签"的体验。
import math
import random
import struct
import time
import wave

from PySide6.QtCore import QEasingCurve, QPropertyAnimation, QPoint, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QColor, QFont, QLinearGradient, QPainter, QPainterPath, QPen
from PySide6.QtMultimedia import QSoundEffect
from PySide6.QtWidgets import QFrame

import config
from widgets.easter.base import easter_popup_pos


class FortuneStickPopup(QFrame):
    """许愿签彩蛋弹窗：纯 QPainter 绘制签筒摇晃动画，摇完弹出运势签纸并发射 finished 信号。"""

    finished = Signal(str, str)

    # 运势签库：按等级（大吉→小凶）排列，抽取时均匀随机
    FORTUNES = [
        {'level': '大吉', 'summary': '灵感到位，适合开新坑。', 'good': '提交、沟通、做决定', 'bad': '反复犹豫'},
        {'level': '大吉', 'summary': '今天手感爆棚，写啥都顺。', 'good': '攻坚难题、重构优化', 'bad': '摸鱼划水'},
        {'level': '大吉', 'summary': '代码之神眷顾你，放手去做。', 'good': '尝试新技术、开源贡献', 'bad': '自我怀疑'},
        {'level': '中吉', 'summary': '小步快跑，越做越顺。', 'good': '先做 MVP、补测试', 'bad': '一上来重构'},
        {'level': '中吉', 'summary': '效率在线，节奏把握好。', 'good': '完成待办、修复已知问题', 'bad': '开太多分支'},
        {'level': '中吉', 'summary': '适合推进核心功能。', 'good': '实现主流程、加文档', 'bad': '纠结命名'},
        {'level': '小吉', 'summary': '今天适合稳一点。', 'good': '整理待办、修小 Bug', 'bad': '硬刚玄学问题'},
        {'level': '小吉', 'summary': '细水长流，慢就是快。', 'good': '完善注释、补充测试', 'bad': '盲目提速'},
        {'level': '小吉', 'summary': '温和推进即可，别太激进。', 'good': '优化细节、清理代码', 'bad': '大改架构'},
        {'level': '平', 'summary': '先喝水，再继续。', 'good': '收尾、备份、复盘', 'bad': '通宵爆肝'},
        {'level': '平', 'summary': '平常心对待，顺其自然。', 'good': '日常维护、读文档', 'bad': '急功近利'},
        {'level': '平', 'summary': '保持状态即可，不必强求。', 'good': '整理环境、同步进度', 'bad': '硬拼产出'},
        {'level': '末吉', 'summary': '别急，换个角度会更快。', 'good': '求助、拆小任务', 'bad': '边写边推翻'},
        {'level': '末吉', 'summary': '今天可能会绕弯路。', 'good': '复习基础、问问前辈', 'bad': '闭门造车'},
        {'level': '末吉', 'summary': '卡住了就先放放。', 'good': '换个模块、休息一下', 'bad': '死磕到底'},
        {'level': '小凶', 'summary': '今天容易出小状况。', 'good': '多备份、勤提交', 'bad': '大改动、跳步骤'},
        {'level': '小凶', 'summary': '运气略差，谨慎行事。', 'good': '检查配置、多测试', 'bad': '快速迭代、跳过验证'},
    ]

    def __init__(self, x, y, parent=None):
        """抽取运势、启动动画定时器并播放摇晃音效。"""
        super().__init__(parent)
        self.started_at = time.monotonic()
        self.result_at = 0.0
        self.result = random.choice(self.FORTUNES)
        self.sound_effects = {}
        self.dragging = False
        self.drag_start_pos = QPoint()
        self.drag_window_pos = QPoint()
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool | Qt.NoDropShadowWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setFixedSize(300, 350)
        self.anim_timer = QTimer(self)
        self.anim_timer.timeout.connect(self._tick)
        self.anim_timer.start(16)  # 约 60fps 驱动摇晃动画
        self.life_timer = QTimer(self)
        self.life_timer.setSingleShot(True)
        self.life_timer.timeout.connect(self.close)
        self.move_to_anchor(x, y)
        self.show()
        self.raise_()
        self._fade_in()
        self._play_shake_sound()

    def move_to_anchor(self, x, y):
        """把窗口移动到锚点（宠物位置）上方的合法位置。"""
        self.move(easter_popup_pos(x, y, self.size()))

    def mousePressEvent(self, event):
        """右键 0.4s 内双击关闭窗口；左键进入拖拽。"""
        if event.button() == Qt.RightButton:
            now = time.time()
            if now - getattr(self, '_last_right_click_time', 0) < 0.4:
                self.close()
                self._last_right_click_time = 0
            else:
                self._last_right_click_time = now
            event.accept()
            return
        if event.button() == Qt.LeftButton:
            self.dragging = True
            self.drag_start_pos = event.globalPos()
            self.drag_window_pos = self.pos()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        """拖拽中跟随鼠标移动窗口。"""
        if self.dragging and event.buttons() & Qt.LeftButton:
            self.move(self.drag_window_pos + event.globalPos() - self.drag_start_pos)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        """左键释放时结束拖拽状态。"""
        if event.button() == Qt.LeftButton:
            self.dragging = False
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def _fade_in(self):
        """用 160ms 透明度渐变实现弹窗淡入。"""
        self.setWindowOpacity(0.0)
        anim = QPropertyAnimation(self, b'windowOpacity', self)
        anim.setDuration(160)
        anim.setStartValue(0.0)
        anim.setEndValue(1.0)
        anim.setEasingCurve(QEasingCurve.OutCubic)
        anim.start()
        self.fade_anim = anim

    def _tick(self):
        """动画帧回调：2.35s 摇晃结束时记录时刻并发射 finished 信号。"""
        elapsed = time.monotonic() - self.started_at
        if self.result_at == 0.0 and elapsed >= 2.35:
            self.result_at = time.monotonic()
            self.finished.emit(self.result['level'], self.result['summary'])
        self.update()

    def _ease_out(self, t):
        """三次方缓出曲线，用于签升起/签纸滑入的减速阶段。"""
        t = max(0.0, min(1.0, t))
        return 1 - pow(1 - t, 3)

    def _play_shake_sound(self):
        """加载（缺失则合成）签筒摇晃音效并播放。"""
        sound_dir = config.RES_DIR / 'sounds' / 'easter'
        sound_dir.mkdir(parents=True, exist_ok=True)
        path = sound_dir / 'fortune_shake.wav'
        if not path.is_file():
            self._write_shake_sound(path)
        effect = QSoundEffect(self)
        effect.setSource(QUrl.fromLocalFile(str(path)))
        effect.setVolume(float(config.app_config.get('volume', 0.4)))
        effect.play()
        self.sound_effects['fortune_shake'] = effect

    def _write_shake_sound(self, path):
        """用纯 Python 合成 1.7 秒的签筒摇晃音并写出 WAV 文件。"""
        # 合成签筒摇晃音：周期性脉冲调制 + 随机颗粒噪声 + 木质谐波叠加，模拟竹签碰撞感
        sample_rate = 44100
        duration = 1.7
        frames = bytearray()
        for i in range(int(sample_rate * duration)):
            t = i / sample_rate
            pulse = max(0.0, math.sin(2 * math.pi * 9.5 * t))
            env = (0.55 + 0.45 * math.exp(-1.2 * t)) * pulse
            knock = math.sin(2 * math.pi * 220 * t) * math.exp(-28 * (t % 0.105)) * 0.28
            rattle = random.uniform(-1, 1) * env * 0.22
            wood = math.sin(2 * math.pi * 520 * t) * env * 0.08
            sample = (knock + rattle + wood) * max(0.0, 1 - t / duration)
            frames.extend(struct.pack('<h', int(max(-1, min(1, sample)) * 32767)))  # 限幅后转 16-bit PCM
        with wave.open(str(path), 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(bytes(frames))

    def _shake_offset(self, elapsed):
        """根据经过时间返回签筒当前的水平抖动偏移（像素）。"""
        # 摇晃偏移分三段：前 1.65s 大幅振动（签筒摇动）→ 之后 0.7s 衰减 → 静止
        # 用正弦驱动横向抖动，频率和幅度随时间递减，感觉上比线性衰减自然
        if elapsed < 1.65:
            amp = 10 * (1 - elapsed / 1.65) + 4
            return amp * math.sin(elapsed * 48)
        if elapsed < 2.35:
            return 3 * math.sin(elapsed * 22) * (1 - (elapsed - 1.65) / 0.7)
        return 0

    def paintEvent(self, event):
        """逐帧绘制：背景 → 地面阴影 → 签筒 → 签 → 签纸或提示文字。"""
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        now = time.monotonic()
        elapsed = now - self.started_at

        self._draw_bg(painter)
        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor(88, 52, 20, 36))
        painter.drawEllipse(78, 296, 144, 18)
        self._draw_bamboo_cup(painter, elapsed)
        self._draw_sticks(painter, elapsed)
        if self.result_at > 0.0:
            # 签纸用 0.62 秒完成滑入渐显动画
            self._draw_fortune_paper(painter, min(1.0, (now - self.result_at) / 0.62))
        else:
            self._draw_hint(painter, elapsed)

    def _draw_bg(self, painter):
        """绘制米黄渐变圆角背景卡片和标题文字。"""
        painter.setPen(QPen(QColor(222, 194, 140, 190), 1.2))
        grad = QLinearGradient(0, 0, 0, self.height())
        grad.setColorAt(0, QColor(255, 252, 241, 248))
        grad.setColorAt(1, QColor(255, 239, 210, 244))
        painter.setBrush(grad)
        painter.drawRoundedRect(12, 12, self.width() - 24, self.height() - 24, 24, 24)
        painter.setFont(QFont('Microsoft YaHei UI', 13, QFont.Bold))
        painter.setPen(QColor(92, 59, 24, 230))
        painter.drawText(0, 28, self.width(), 28, Qt.AlignCenter, '今日求签')

    def _draw_bamboo_cup(self, painter, elapsed):
        """绘制竹签筒：梯形筒身渐变、筒口椭圆和竖向竹纹，整体随摇晃偏移。"""
        xoff = self._shake_offset(elapsed)
        painter.save()
        painter.translate(xoff, 0)
        body = QPainterPath()
        body.moveTo(94, 137)
        body.cubicTo(105, 130, 195, 130, 206, 137)
        body.lineTo(190, 288)
        body.cubicTo(178, 299, 122, 299, 110, 288)
        body.closeSubpath()
        grad = QLinearGradient(92, 130, 208, 298)
        grad.setColorAt(0, QColor(196, 137, 64))
        grad.setColorAt(0.48, QColor(133, 78, 34))
        grad.setColorAt(1, QColor(81, 46, 24))
        painter.setBrush(grad)
        painter.setPen(QPen(QColor(91, 52, 25), 2))
        painter.drawPath(body)
        painter.setBrush(QColor(231, 184, 106))
        painter.drawEllipse(89, 123, 122, 31)
        painter.setBrush(QColor(76, 43, 24))
        painter.drawEllipse(104, 132, 92, 17)
        painter.setPen(QPen(QColor(245, 203, 124, 135), 2))
        for x in (122, 150, 178):
            painter.drawLine(x, 151, x - 5, 278)
        painter.restore()

    def _draw_sticks(self, painter, elapsed):
        """绘制签筒内的竹签，被选中的签会先升起再落回。"""
        # 第 i==3 根签（chosen）在动画中会上升再落下，其余签静止作背景
        # rise/fall 分段缓动：先弹出签口再回落，营造"签自己跳出来"的感觉
        xoff = self._shake_offset(elapsed)
        rise = 0
        fall = 0
        if elapsed > 1.18:
            rise = 108 * self._ease_out((elapsed - 1.18) / 0.75)  # 1.18s 后升起 108px
        if elapsed > 1.9:
            fall = 26 * self._ease_out((elapsed - 1.9) / 0.42)  # 1.9s 后回落 26px
        angles = [-17, -10, -4, 4, 11, 18]
        for i, angle in enumerate(angles):
            chosen = i == 3
            extra = rise - fall if chosen else 0
            painter.save()
            painter.translate(150 + xoff, 146 - extra)
            painter.rotate(angle + xoff * 0.75 + (8 * self._ease_out((elapsed - 1.7) / 0.5) if chosen else 0))
            painter.setPen(QPen(QColor(222, 176, 92), 7, Qt.SolidLine, Qt.RoundCap))
            painter.drawLine(0, 0, 0, 128)
            painter.setPen(QPen(QColor(115, 66, 31), 1.6, Qt.SolidLine, Qt.RoundCap))
            painter.drawLine(0, 6, 0, 124)
            if chosen:
                painter.setBrush(QColor(204, 47, 42))
                painter.setPen(Qt.NoPen)
                painter.drawRoundedRect(-9, -16, 18, 25, 4, 4)
            painter.restore()

    def _draw_fortune_paper(self, painter, progress):
        """绘制弹出后的签纸：等级大字、一句话总结和宜/忌列表。"""
        # 签纸以缓出动画从上方滑入，alpha 随 progress 渐显，避免生硬弹出感
        p = self._ease_out(progress)
        y = 62 + int((1 - p) * 54)
        alpha = int(255 * p)
        painter.setPen(QPen(QColor(181, 131, 64, alpha), 2))
        painter.setBrush(QColor(255, 251, 235, alpha))
        painter.drawRoundedRect(42, y, 216, 126, 15, 15)
        painter.setPen(QPen(QColor(210, 48, 42, alpha), 1.4))
        painter.drawLine(65, y + 42, 235, y + 42)
        font = QFont('Microsoft YaHei UI', 18, QFont.Bold)
        painter.setFont(font)
        painter.setPen(QColor(180, 42, 36, alpha))
        painter.drawText(42, y + 10, 216, 30, Qt.AlignCenter, self.result['level'])
        font = QFont('Microsoft YaHei UI', 9, QFont.Bold)
        painter.setFont(font)
        painter.setPen(QColor(82, 53, 25, alpha))
        painter.drawText(56, y + 50, 188, 24, Qt.AlignCenter | Qt.TextWordWrap, self.result['summary'])
        font = QFont('Microsoft YaHei UI', 8)
        painter.setFont(font)
        painter.setPen(QColor(112, 73, 34, alpha))
        painter.drawText(58, y + 78, 184, 18, Qt.AlignLeft, '宜：' + self.result['good'])
        painter.drawText(58, y + 98, 184, 18, Qt.AlignLeft, '忌：' + self.result['bad'])

    def _draw_hint(self, painter, elapsed):
        """摇晃期间在筒上方显示带省略号动画的等待提示。"""
        dots = '.' * (1 + int(elapsed * 4) % 3)  # 省略号循环：1~3 个点
        font = QFont('Microsoft YaHei UI', 10, QFont.Bold)
        painter.setFont(font)
        painter.setPen(QColor(103, 67, 34, 210))
        painter.drawText(0, 63, self.width(), 24, Qt.AlignCenter, '签筒正在摇动' + dots)

    def closeEvent(self, event):
        """关闭时停止动画帧与生命周期定时器。"""
        self.anim_timer.stop()
        self.life_timer.stop()
        super().closeEvent(event)
