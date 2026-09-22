# coding:utf-8
# 彩蛋弹窗公共基类：统一管理无边框窗口的生命周期、音效缓存、缓动函数和拖拽交互。
# 所有彩蛋小游戏（扭蛋/骰子/硬币等）继承此类，各自只需实现 paintEvent 绘制逻辑。
# 音效文件按需合成落盘并通过类级 _sound_cache 复用路径，避免多实例重复生成。
import math
import random
import struct
import time
import wave

from PySide6.QtCore import QEasingCurve, QPropertyAnimation, QPoint, Qt, QTimer, QUrl
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtMultimedia import QSoundEffect
from PySide6.QtWidgets import QApplication, QFrame

import config
import theme as _theme

EASTER_POPUP_GAP = 16


def _parse_theme_color(css_value, fallback):
    """从 CSS 颜色值提取 RGBA 分量，失败时返回 fallback tuple。"""
    import re
    if isinstance(css_value, (tuple, list)):
        return tuple(css_value)
    s = str(css_value).strip()
    m = re.match(r'rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)', s)
    if m:
        r, g, b = int(m.group(1)), int(m.group(2)), int(m.group(3))
        a = int(float(m.group(4)) * (1 if float(m.group(4)) <= 1 else 1)) if m.group(4) else 255
        a = int(float(m.group(4)) * 255) if m.group(4) and float(m.group(4)) <= 1 else (int(m.group(4)) if m.group(4) else 255)
        return (r, g, b, a)
    if s.startswith('#'):
        h = s.lstrip('#')
        if len(h) == 6:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 230)
    return fallback


def easter_popup_pos(x, y, size, gap=EASTER_POPUP_GAP):
    """计算弹窗在锚点上方的展示位置，并夹紧到屏幕可用区。"""
    # 将弹窗定位于锚点（宠物位置）正上方，并夹紧到当前屏幕可用区，
    # 防止窗口溢出屏幕边缘（多显示器场景也能正确定位）
    screen = QApplication.screenAt(QPoint(int(x), int(y))) or QApplication.primaryScreen()
    pos = QPoint(int(x - size.width() / 2), int(y - size.height() - gap))
    if screen is not None:
        area = screen.availableGeometry()
        pos.setX(max(area.left() + 4, min(pos.x(), area.right() - size.width() - 4)))
        pos.setY(max(area.top() + 4, min(pos.y(), area.bottom() - size.height() - 4)))
    return pos


class EasterGamePopup(QFrame):
    """彩蛋小游戏无边框弹窗基类：动画帧驱动、音效合成播放、拖拽与右键双击关闭。"""

    title = '小游戏'
    life_ms = 9000
    _sound_cache = {}

    def __init__(self, x, y, parent=None):
        """初始化无边框窗口，启动 16ms 动画帧定时器并淡入显示。"""
        super().__init__(parent)
        self.started_at = time.monotonic()
        self.dragging = False
        self.drag_start_pos = QPoint()
        self.drag_window_pos = QPoint()
        self.anchor_x = int(x)
        self.anchor_y = int(y)
        self.fade_anim = None
        self.played_sounds = set()
        self.sound_effects = {}
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool | Qt.NoDropShadowWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setFixedSize(280, 260)
        self.anim_timer = QTimer(self)
        self.anim_timer.timeout.connect(self._tick)
        self.anim_timer.start(16)  # 约 60fps 驱动 paintEvent 重绘
        self.life_timer = QTimer(self)
        self.life_timer.setSingleShot(True)
        self.life_timer.timeout.connect(self.close)
        # 彩蛋小铺的小游戏由用户右键关闭，不自动消失。
        self.move_to_anchor(x, y)
        self.show()
        self.raise_()
        self._fade_in()

    def move_to_anchor(self, x, y):
        """记录锚点并把窗口移动到锚点上方的合法位置。"""
        self.anchor_x = int(x)
        self.anchor_y = int(y)
        self.move(easter_popup_pos(x, y, self.size()))

    def _fade_in(self):
        """用 160ms 窗口透明度渐变实现弹窗淡入。"""
        self.setWindowOpacity(0.0)
        anim = QPropertyAnimation(self, b'windowOpacity', self)
        anim.setDuration(160)
        anim.setStartValue(0.0)
        anim.setEndValue(1.0)
        anim.setEasingCurve(QEasingCurve.OutCubic)
        anim.start()
        self.fade_anim = anim

    def _tick(self):
        """动画帧回调：请求重绘以驱动 paintEvent 内的逐帧动画。"""
        self.update()

    def _play_once(self, key, kind):
        """播放指定音效，同一 key 只播一次（防止重绘期重复触发）。"""
        # 用 played_sounds 集合保证同一音效在同一次动画中只触发一次，
        # 避免 paintEvent 高频重绘时重复播放
        if key in self.played_sounds:
            return
        self.played_sounds.add(key)
        self._play_sound(kind)

    def _play_sound(self, kind):
        """加载（或合成）指定音效并按全局音量播放。"""
        path = self._ensure_sound(kind)
        if path is None:
            return
        effect = QSoundEffect(self)
        effect.setSource(QUrl.fromLocalFile(str(path)))
        effect.setVolume(float(config.app_config.get('volume', 0.4)))
        effect.play()
        # 用时间戳作 key 持有引用，防止 QSoundEffect 被垃圾回收导致播放中断
        self.sound_effects[kind + str(time.monotonic())] = effect

    def _ensure_sound(self, kind):
        """返回指定音效的 WAV 路径，缺失时合成生成并写入类级缓存。"""
        if kind in self._sound_cache:
            return self._sound_cache[kind]
        sound_dir = config.RES_DIR / 'sounds' / 'easter'
        sound_dir.mkdir(parents=True, exist_ok=True)
        path = sound_dir / f'{kind}.wav'
        if not path.is_file():
            self._write_sound(path, kind)
        self._sound_cache[kind] = path
        return path

    def _write_sound(self, path, kind):
        """按音效类型用纯 Python 合成波形并写出 WAV 文件。"""
        # 根据 kind 用不同的合成参数生成波形：
        # coin/open 用谐波叠加，dice/drop 加随机噪声，tick/click 用短促高频脉冲
        # 统一输出为 16-bit mono 44100Hz WAV，兼容 QSoundEffect 直接播放
        sample_rate = 44100
        duration = {
            'click': 0.08, 'tick': 0.05, 'drop': 0.16, 'open': 0.32,
            'coin': 0.55, 'dice': 0.42, 'mystic': 0.8,
        }.get(kind, 0.18)
        total = int(sample_rate * duration)
        frames = bytearray()
        for i in range(total):
            t = i / sample_rate
            if kind == 'coin':
                env = math.exp(-4.0 * t)
                freq = 1050 + 800 * math.sin(t * 48)
                sample = math.sin(2 * math.pi * freq * t) * env * 0.33
            elif kind == 'dice':
                env = math.exp(-7.0 * t)
                noise = random.uniform(-1, 1) * env * 0.22
                sample = noise + math.sin(2 * math.pi * 140 * t) * env * 0.18
            elif kind == 'drop':
                env = math.exp(-16 * t)
                sample = (math.sin(2 * math.pi * 150 * t) + random.uniform(-0.5, 0.5)) * env * 0.32
            elif kind == 'open':
                env = math.exp(-5 * t)
                sample = (math.sin(2 * math.pi * 660 * t) + 0.5 * math.sin(2 * math.pi * 990 * t)) * env * 0.24
            elif kind == 'mystic':
                env = min(1.0, t * 5) * math.exp(-1.4 * t)
                sample = (math.sin(2 * math.pi * 330 * t) + 0.45 * math.sin(2 * math.pi * 495 * t)) * env * 0.20
            elif kind == 'tick':
                env = math.exp(-80 * t)
                sample = math.sin(2 * math.pi * 1800 * t) * env * 0.36
            else:
                env = math.exp(-55 * t)
                sample = math.sin(2 * math.pi * 900 * t) * env * 0.34
            frames.extend(struct.pack('<h', int(max(-1, min(1, sample)) * 32767)))  # 限幅后转 16-bit PCM
        with wave.open(str(path), 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(bytes(frames))

    def _elapsed(self):
        """返回动画开始后经过的秒数。"""
        return time.monotonic() - self.started_at

    def _ease_out(self, t):
        """三次方缓出曲线，用于减速到位的动画阶段。"""
        t = max(0.0, min(1.0, t))
        return 1 - pow(1 - t, 3)

    def _ease_in_out(self, t):
        """平滑加减速曲线（smoothstep），用于往返类动画。"""
        t = max(0.0, min(1.0, t))
        return t * t * (3 - 2 * t)

    def _spring(self, t, damping=5.5, frequency=13.0):
        # 阻尼弹簧函数：用于模拟弹跳落地后的余振，比普通缓动更有物理感
        t = max(0.0, t)
        return math.exp(-damping * t) * math.cos(frequency * t)

    def _impact(self, t, duration=0.32):
        """冲击脉冲包络：单峰正弦乘指数衰减，模拟落地瞬间的顿挫。"""
        if t < 0 or t > duration:
            return 0.0
        p = t / duration
        return math.sin(p * math.pi) * math.exp(-3.0 * p)

    def mousePressEvent(self, event):
        """右键 0.4s 内双击关闭窗口；左键点击空白区进入拖拽。"""
        if event.button() == Qt.RightButton:
            now = time.time()
            if now - getattr(self, '_last_right_click_time', 0) < 0.4:
                self.close()
                self._last_right_click_time = 0
            else:
                self._last_right_click_time = now
            event.accept()
            return
        # 只有点击空白区域（非子控件）才触发拖拽，防止按钮等子控件被意外拦截
        if event.button() == Qt.LeftButton and self.childAt(event.pos()) is None:
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

    def resizeEvent(self, event):
        """尺寸变化时重新贴靠锚点（拖拽中除外，避免打断用户操作）。"""
        super().resizeEvent(event)
        if not self.dragging:
            self.move(easter_popup_pos(self.anchor_x, self.anchor_y, self.size()))

    def _draw_card(self, painter, bg=None, border=None):
        """绘制统一卡片背景：投影、圆角面板和主题色标题文字。"""
        t = _theme.current_theme()
        if bg is None:
            bg = QColor(*_parse_theme_color(t['card']['bg'], (255, 250, 238, 246)))
        if border is None:
            border = QColor(*_parse_theme_color(t['card']['border'], (225, 205, 165, 230)))
        fg = QColor(t['easter_fg'])
        painter.setRenderHint(QPainter.Antialiasing)
        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor(0, 0, 0, 30))
        # 先画半透明黑投影，再上移几像素画主体，形成悬浮卡片层次感
        painter.drawRoundedRect(18, 20, self.width() - 36, self.height() - 30, 22, 22)
        painter.setBrush(bg)
        painter.setPen(QPen(border, 1.5))
        painter.drawRoundedRect(14, 14, self.width() - 28, self.height() - 32, 22, 22)
        painter.setFont(QFont('Microsoft YaHei UI', 13, QFont.Bold))
        painter.setPen(fg)
        painter.drawText(0, 26, self.width(), 26, Qt.AlignCenter, self.title)

    def closeEvent(self, event):
        """关闭时停止动画帧与生命周期定时器，释放资源。"""
        self.anim_timer.stop()
        self.life_timer.stop()
        super().closeEvent(event)
