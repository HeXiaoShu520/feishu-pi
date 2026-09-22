# coding:utf-8
"""
桌宠动画播放线程。

AnimationWorker 按角色资源中的动作配置循环播放帧图，向 DesktopPet 发出当前
pixmap、锚点和移动偏移。它只负责节奏和动作选择，不直接操作窗口。
"""

import random
import time

from PySide6.QtCore import QObject, QThread, Signal


class AnimationWorker(QObject):
    """在工作线程中按动作配置播放宠物动画帧。"""

    image_changed = Signal(object, list, object)  # pixmap, anchor, act
    move_requested = Signal(float, float)
    finished = Signal()

    def __init__(self, profile, parent=None):
        super().__init__(parent)
        self.profile = profile
        self.running = True
        self.paused = False
        self.pending_acts = None

    def stop(self):
        self.running = False
        self.paused = False

    def pause(self):
        self.paused = True

    def resume(self):
        self.paused = False

    def play(self, acts):
        self.pending_acts = list(acts)
        self.paused = False

    def run(self):
        # 启动时短暂等待，确保主线程的窗口已完成初始化再开始发信号
        time.sleep(0.2)
        while self.running:
            if self.pending_acts:
                acts = self.pending_acts
                self.pending_acts = None
                self._run_acts(acts)
                self.finished.emit()
                continue
            if self.paused:
                time.sleep(0.05)
                continue
            self._run_acts(self._choose_random_acts())

    def _choose_random_acts(self):
        # 加权随机选取下一段动作序列，权重为各 item 的 prob 字段
        # 使用线性扫描而非 random.choices，方便兼容自定义概率格式
        choices = self.profile.random_acts
        if not choices:
            return [self.profile.default]
        total = sum(max(0.0, item['prob']) for item in choices)
        if total <= 0:
            return [self.profile.default]
        mark = random.uniform(0, total)
        current = 0.0
        for item in choices:
            current += max(0.0, item['prob'])
            if mark <= current:
                return item['acts']
        return [self.profile.default]

    def _run_acts(self, acts):
        for act in acts:
            self._run_act(act)
            # 检查三个中断条件，任意一个为真立即跳出当前动作序列
            if not self.running or self.paused or self.pending_acts:
                break

    def _run_act(self, act):
        for _ in range(max(1, act.act_num)):
            for image in act.images:
                if not self.running or self.paused or self.pending_acts:
                    return
                self.image_changed.emit(image, act.anchor, act)
                self._move(act)
                time.sleep(max(0.01, act.frame_refresh))

    def _move(self, act):
        dx = 0.0
        dy = 0.0
        if act.direction == 'right':
            dx = act.frame_move
        elif act.direction == 'left':
            dx = -act.frame_move
        elif act.direction == 'up':
            dy = -act.frame_move
        elif act.direction == 'down':
            dy = act.frame_move
        if dx or dy:
            self.move_requested.emit(dx, dy)


class AnimationThread(QThread):
    def __init__(self, profile, parent=None):
        super().__init__(parent)
        self.worker = AnimationWorker(profile)
        self.worker.moveToThread(self)
        self.started.connect(self.worker.run)

    def stop(self):
        self.worker.stop()
        self.quit()
        self.wait(1000)
