# coding:utf-8
# 电子木鱼彩蛋：点击木鱼积累今日功德计数，并播放敲击动画和音效。
# 计数按日期存储在本地 JSON 文件，每天重新开始，不跨日累加。
import json
import math
import struct
import time
import wave
from datetime import date

from PySide6.QtCore import QEasingCurve, QPropertyAnimation, QPoint, QPointF, QRectF, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QColor, QPainter, QPen, QPixmap, QTransform
from PySide6.QtMultimedia import QSoundEffect
from PySide6.QtWidgets import QFrame

import config
from widgets.easter.base import easter_popup_pos


class WoodenFishPopup(QFrame):
    """电子木鱼弹窗：自绘木鱼与木槌动画，点击计数并持久化今日功德。"""

    knocked = Signal(int)

    def __init__(self, x, y, parent=None):
        """初始化资源、音效轮询池与 16ms 动画定时器，并淡入显示。"""
        super().__init__(parent)
        self.today_key = date.today().isoformat()
        self.count = self._load_today_count()
        self.hit_started_at = 0.0
        self.popups = []
        self.ripples = []
        self.dragging = False
        self.drag_start_pos = QPoint()
        self.drag_window_pos = QPoint()
        self.press_pos = QPoint()
        self.muyu = QPixmap(str(config.RES_DIR / 'items' / 'wooden_fish' / 'muyu.png'))
        self.hammer = QPixmap(str(config.RES_DIR / 'items' / 'wooden_fish' / 'hammer.png'))
        self.audio_players = []
        self.audio_index = 0
        sound_path = self._ensure_knock_sound()
        # 预先创建 5 个 QSoundEffect 实例做轮询播放，避免同一 effect 连击时被截断
        if sound_path is not None:
            source = QUrl.fromLocalFile(str(sound_path))
            volume = float(config.app_config.get('volume', 0.4))
            for _ in range(5):
                effect = QSoundEffect(self)
                effect.setSource(source)
                effect.setVolume(volume)
                self.audio_players.append(effect)
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool | Qt.NoDropShadowWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setFixedSize(250, 190)
        self.anim_timer = QTimer(self)
        self.anim_timer.timeout.connect(self._tick)
        self.anim_timer.start(16)  # 约 60fps 的动画刷新
        self.life_timer = QTimer(self)
        self.life_timer.setSingleShot(True)
        self.life_timer.timeout.connect(self.close)
        self.move_to_anchor(x, y)
        self.show()
        self.raise_()
        self._fade_in()

    def _store_path(self):
        """返回功德计数 JSON 文件路径。"""
        return config.DATA_DIR / 'wooden_fish.json'

    def _load_today_count(self):
        """读取今日功德计数，文件缺失或损坏时按 0 处理。"""
        path = self._store_path()
        if not path.is_file():
            return 0
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except Exception:
            return 0
        return int(data.get(self.today_key, 0) or 0)

    def _save_today_count(self):
        """把今日计数写回 JSON（保留其他日期的数据）。"""
        path = self._store_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {}
        if path.is_file():
            try:
                data = json.loads(path.read_text(encoding='utf-8'))
            except Exception:
                data = {}
        data[self.today_key] = self.count
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')

    def _ensure_knock_sound(self):
        """确保敲击音效存在并返回其路径，必要时现场合成。"""
        # 优先使用资源目录中已有的音频；不存在时用纯 Python 合成一段木鱼敲击音并落盘
        # 合成逻辑：瞬态打击（hit）+ 带衰减包络的谐波（tone），模拟木质共鸣
        sound_path = config.RES_DIR / 'sounds' / 'WoodenFish.wav'
        if sound_path.is_file():
            return sound_path
        mp3_path = config.RES_DIR / 'sounds' / 'WoodenFish.mp3'
        if mp3_path.is_file():
            return mp3_path
        sound_path.parent.mkdir(parents=True, exist_ok=True)
        sample_rate = 44100
        duration = 0.22
        total = int(sample_rate * duration)
        with wave.open(str(sound_path), 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            frames = bytearray()
            for i in range(total):
                t = i / sample_rate
                env = math.exp(-18 * t)
                hit = math.exp(-220 * t) * math.sin(2 * math.pi * 118 * t)
                tone = 0.68 * math.sin(2 * math.pi * 430 * t) + 0.26 * math.sin(2 * math.pi * 760 * t)
                sample = int(max(-1, min(1, (hit + tone * env) * 0.42)) * 32767)
                frames.extend(struct.pack('<h', sample))
            wf.writeframes(bytes(frames))
        return sound_path

    def move_to_anchor(self, x, y):
        """按统一的彩蛋弹窗锚点规则定位窗口。"""
        self.move(easter_popup_pos(x, y, self.size()))

    def knock(self):
        """执行一次敲击。"""
        # 每次敲击：计数+1、持久化、产生动画弹出文字、触发水波纹、轮询播放音效
        now = time.monotonic()
        self.count += 1
        self._save_today_count()
        self.hit_started_at = now
        self.popups.append({'text': '功德 +1', 'start': now})
        self.ripples.append({'start': now})
        if self.audio_players:
            player = self.audio_players[self.audio_index % len(self.audio_players)]
            self.audio_index += 1
            player.stop()
            player.play()
        self.knocked.emit(self.count)
        self.update()

    def mousePressEvent(self, event):
        """右键 0.4s 内双击关闭窗口；左键记录按下位置用于区分敲击与拖拽。"""
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
            self.dragging = False
            self.press_pos = event.globalPos()
            self.drag_start_pos = event.globalPos()
            self.drag_window_pos = self.pos()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        """左键拖拽移动窗口，位移超过 6px（曼哈顿距离）判定进入拖拽态。"""
        if not (event.buttons() & Qt.LeftButton):
            return super().mouseMoveEvent(event)
        delta = event.globalPos() - self.drag_start_pos
        if not self.dragging and delta.manhattanLength() >= 6:
            self.dragging = True
        if self.dragging:
            self.move(self.drag_window_pos + delta)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        # 只有鼠标按下和松开都在同一位置（曼哈顿距离 < 6）才算一次敲击，
        # 超过阈值说明用户在拖拽窗口，不触发敲击
        if event.button() == Qt.LeftButton:
            if not self.dragging and (event.globalPos() - self.press_pos).manhattanLength() < 6:
                self.knock()
            self.dragging = False
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def _fade_in(self):
        """窗口 140ms 淡入动画。"""
        self.setWindowOpacity(0.0)
        anim = QPropertyAnimation(self, b'windowOpacity', self)
        anim.setDuration(140)
        anim.setStartValue(0.0)
        anim.setEndValue(1.0)
        anim.setEasingCurve(QEasingCurve.OutCubic)
        anim.start()
        self.fade_anim = anim

    def _tick(self):
        """动画帧驱动：清理过期的弹出文字与水波纹并触发重绘。"""
        now = time.monotonic()
        self.popups = [p for p in self.popups if now - p['start'] < 0.9]
        self.ripples = [r for r in self.ripples if now - r['start'] < 0.45]
        self.update()

    def _hit_progress(self):
        """返回敲击动画进度 0~1（总时长约 0.26s），未敲击时视为已结束。"""
        if not self.hit_started_at:
            return 1.0
        p = (time.monotonic() - self.hit_started_at) / 0.26
        return max(0.0, min(1.0, p))

    def _ease_out(self, t):
        """三次方缓出曲线，用于各段动画的平滑过渡。"""
        return 1 - pow(1 - max(0.0, min(1.0, t)), 3)

    def _fish_scale(self):
        """计算当前帧木鱼缩放系数。"""
        # 敲击后木鱼先压缩（模拟受力形变）再弹回略微超调，最后归位
        # 三段分段缓动：压缩 → 弹出 → 收回，总时长约 260ms
        p = self._hit_progress()
        if p >= 1:
            return 1.0
        if p < 0.28:
            return 1.0 - 0.08 * self._ease_out(p / 0.28)
        if p < 0.58:
            return 0.92 + 0.13 * self._ease_out((p - 0.28) / 0.30)
        return 1.05 - 0.05 * self._ease_out((p - 0.58) / 0.42)

    def _hammer_angle(self):
        """按敲击进度分段计算木槌旋转角：抬起 → 劈下 → 回弹 → 归位。"""
        p = self._hit_progress()
        rest = 32
        if p >= 1:
            return rest
        if p < 0.18:
            return rest + 8 * self._ease_out(p / 0.18)
        if p < 0.52:
            return 40 - 35 * self._ease_out((p - 0.18) / 0.34)
        if p < 0.78:
            return 5 + 19 * self._ease_out((p - 0.52) / 0.26)
        return 24 + 8 * self._ease_out((p - 0.78) / 0.22)

    def _hammer_offset(self):
        """按敲击进度分段计算木槌枢轴平移量，与旋转配合形成敲击轨迹。"""
        p = self._hit_progress()
        if p >= 1:
            return QPointF(0, 0)
        if p < 0.18:
            lift = self._ease_out(p / 0.18)
            return QPointF(4 * lift, -6 * lift)
        if p < 0.52:
            drop = self._ease_out((p - 0.18) / 0.34)
            return QPointF(4 - 10 * drop, -6 + 34 * drop)
        if p < 0.78:
            bounce = self._ease_out((p - 0.52) / 0.26)
            return QPointF(-6 + 6 * bounce, 28 - 28 * bounce)
        return QPointF(0, 0)

    def paintEvent(self, event):
        """自绘全部内容：水波纹 → 木鱼（带缩放）→ 木槌（带旋转）→ 计数文字与弹出文字。"""
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        now = time.monotonic()

        center = QPoint(int(self.width() * 0.50), int(self.height() * 0.76))
        # 敲击水波纹：椭圆从中心扩散并淡出（时长 0.45s）
        for ripple in self.ripples:
            p = (now - ripple['start']) / 0.45
            alpha = int(150 * (1 - p))
            radius = 20 + 42 * p
            pen = QPen(QColor(245, 182, 83, alpha), 2)
            painter.setPen(pen)
            painter.setBrush(Qt.NoBrush)
            painter.drawEllipse(center, int(radius), int(radius * 0.44))

        fish_scale = self._fish_scale()
        fish_w = int(150 * fish_scale)
        fish_h = int(115 * fish_scale)
        fish_rect = QRectF(center.x() - fish_w / 2, center.y() - fish_h / 2, fish_w, fish_h)
        if not self.muyu.isNull():
            painter.drawPixmap(fish_rect.toRect(), self.muyu)
        else:
            painter.setBrush(QColor(166, 96, 42))
            painter.setPen(QPen(QColor(93, 54, 26), 2))
            painter.drawEllipse(fish_rect)

        if not self.hammer.isNull():
            hammer_w = 118  # 木槌渲染宽度
            # 以枢轴点为原点旋转绘制木槌，形成绕轴挥动效果
            hammer = self.hammer.scaledToWidth(hammer_w, Qt.SmoothTransformation)
            pivot_point = QPointF(self.width() * 0.83, self.height() * 0.42) + self._hammer_offset()
            transform = QTransform()
            transform.translate(pivot_point.x(), pivot_point.y())
            transform.rotate(self._hammer_angle())
            transform.translate(-hammer_w * 0.78, -hammer.height() * 0.50)
            painter.setTransform(transform)
            painter.drawPixmap(0, 0, hammer)
            painter.resetTransform()

        font = painter.font()
        font.setPointSize(12)
        font.setBold(True)
        painter.setFont(font)
        painter.setPen(QColor(118, 72, 32, 235))
        painter.drawText(0, self.height() - 24, self.width(), 24, Qt.AlignCenter, '今日功德 %d' % self.count)

        # "功德 +1" 弹出文字：上浮并淡出（时长 0.9s）
        for pop in self.popups:
            p = (now - pop['start']) / 0.9
            alpha = int(255 * (1 - p))
            y = int(42 - 56 * p)
            painter.setPen(QColor(255, 205, 92, alpha))
            font = painter.font()
            font.setPointSize(13)
            font.setBold(True)
            painter.setFont(font)
            painter.drawText(0, y, self.width(), 24, Qt.AlignCenter, pop['text'])

    def closeEvent(self, event):
        """关闭时停掉动画与生命期定时器，避免泄漏。"""
        self.anim_timer.stop()
        self.life_timer.stop()
        super().closeEvent(event)
