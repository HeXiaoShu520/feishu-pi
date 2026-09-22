# coding:utf-8
"""ASR 轮次池：统一管理"每轮一个 SAUC 会话"的 worker 生命周期。

语音聊天（VoiceController）与日常语音输入（DailyInputController）共用本池，
消除两边各自维护 standby/closing 状态的重复逻辑。

核心规则（由火山 SAUC 协议决定，不可违反）：
- 一条 WebSocket 只服务一个识别轮次；轮次结束必须 finish，禁止复用旧会话
- 连接按需建立（直连握手约 200ms，无需预建 standby；服务端也会在数秒内
  掐掉空闲连接，预建命中率极低）
- worker 空闲被服务端断开属正常现象，静默废弃，不自动重建（避免空转握手）
- 旧轮 worker 进入 closing 集合，其延迟回包由 owner 按身份过滤
"""

from log_util import get_logger
from clients.asr_client import AsrWorker

log = get_logger('voice.pool')


class AsrRoundPool:
    """维护一个活跃 worker（含 standby 预连接）与一组 closing 旧轮 worker。

    通过 worker_factory 注入 AsrWorker 构造方式，便于测试时替换替身；
    通过 handlers 接收带 worker 身份的信号回调，签名均为 (worker, ...)。
    """

    def __init__(self, worker_factory=None, handlers=None, parent=None):
        # worker_factory(parent) → AsrWorker；默认真实构造，测试可注入 Mock 工厂
        self._worker_factory = worker_factory or (lambda parent: AsrWorker(parent=parent))
        # handlers: status/text/final/error 各 (worker, payload)，finished (worker, branch)
        self._handlers = handlers or {}
        self._parent = parent
        self._active = None       # 当前 worker（可能是待命的 standby）
        self._closing = set()     # 已 finish、仍在收末尾 final 的旧轮 worker

    # ── 状态查询 ─────────────────────────────────────────────────────────

    @property
    def active_worker(self):
        """当前 worker；None 表示无可用连接。"""
        return self._active

    @property
    def closing_workers(self):
        """closing 集合的快照副本，供外部身份查询。"""
        return set(self._closing)

    def is_active(self, worker):
        """worker 是否为当前活跃 worker。"""
        return worker is not None and worker is self._active

    def in_closing(self, worker):
        """worker 是否为收尾中的旧轮 worker。"""
        return worker in self._closing

    def set_active(self, worker):
        """直接替换活跃 worker（仅测试或特殊恢复流程使用）。"""
        self._active = worker

    # ── 生命周期操作 ─────────────────────────────────────────────────────

    def discard_dead_active(self):
        """活跃 worker 线程已结束时丢弃，避免复用已结束的 SAUC 会话。"""
        if self._active is not None and not self._active.isRunning():
            self._active = None

    def ensure_standby(self, parent=None):
        """确保存在一个正在运行的 worker（standby 预连接）。"""
        self.discard_dead_active()
        if self._active is None:
            self._active = self._create(parent or self._parent)
        return self._active

    def start_recording(self, parent=None):
        """取可用 worker 并立即开始采集（按下即录，握手期音频自动缓冲）。"""
        worker = self.ensure_standby(parent)
        worker.start_recording()
        return worker

    def stop_capture(self):
        """仅停止麦克风采集，不结束 SAUC 会话（保留连接继续收当前轮结果）。"""
        if self._active is not None:
            self._active.stop_recording()

    def finish_round(self, parent=None):
        """结束当前识别轮次：active → closing 并发送末帧。

        直连后握手仅约 200ms，不再预建 standby（服务端也会在数秒内
        掐掉空闲连接，预建命中率极低）；下一轮按需建连即可。
        返回被结束的 worker（无活跃 worker 时返回 None）。
        注意：本方法不释放音频资源，由 owner 按自己的节奏释放。
        """
        worker = self._active
        self._active = None
        if worker is None:
            return None
        self._closing.add(worker)
        worker.finish()
        return worker

    def discard_active(self):
        """standby 空闲死亡等场景下静默丢弃当前 worker。"""
        self._active = None

    def on_finished(self, worker):
        """finished 信号统一入口：先更新池状态，再转发 owner 回调。

        返回该 worker 结束时所处分支：'closing'（旧轮收尾完成）、
        'active'（当前 worker 结束）或 'unknown'（未知 worker，忽略）。
        """
        if worker in self._closing:
            self._closing.discard(worker)
            branch = 'closing'
        elif worker is self._active:
            self._active = None
            branch = 'active'
        else:
            branch = 'unknown'
        handler = self._handlers.get('finished')
        if handler is not None and branch != 'unknown':
            handler(worker, branch)
        return branch

    def shutdown(self):
        """应用退出：finish 全部 worker 并有界等待，防止线程泄漏。"""
        workers = list(self._closing)
        if self._active is not None:
            workers.append(self._active)
            self._active = None
        self._closing.clear()
        for worker in workers:
            try:
                worker.finish()
                worker.wait(1200)
            except Exception as exc:
                log.warning('关闭 ASR worker 失败: %s', exc)

    # ── 内部实现 ─────────────────────────────────────────────────────────

    def _create(self, parent):
        """创建 worker 并把五个信号绑定 worker 身份后转发给 owner 回调。"""
        worker = self._worker_factory(parent)
        # lambda 捕获 source=worker：旧轮 worker 的延迟回包携带自己的身份，
        # owner 据此过滤，绝不污染新一轮
        worker.status_changed.connect(lambda text, source=worker: self._emit('status', source, text))
        worker.text_received.connect(lambda text, source=worker: self._emit('text', source, text))
        worker.final_received.connect(lambda text, source=worker: self._emit('final', source, text))
        worker.error_received.connect(lambda text, source=worker: self._emit('error', source, text))
        worker.finished_signal.connect(lambda source=worker: self.on_finished(source))
        worker.start()
        return worker

    def _emit(self, name, worker, payload):
        handler = self._handlers.get(name)
        if handler is not None:
            handler(worker, payload)
