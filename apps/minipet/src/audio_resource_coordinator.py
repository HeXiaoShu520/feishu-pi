# coding:utf-8
"""主动录音资源协调器。

只协调需要麦克风采集的主动 ASR，不管理语音球、TTS 或唤醒词 UI。
"""

from PySide6.QtCore import QObject, Signal


class AudioResourceCoordinator(QObject):
    """保证同一时间只有一个主动 ASR 持有录音资源。"""

    released = Signal(str)

    def __init__(self, parent=None):
        """初始化空闲的录音资源协调器。"""
        super().__init__(parent)
        self._owner = ''

    def try_acquire(self, owner):
        """尝试由 owner 持有资源；同一 owner 重入时保持成功。"""
        if self._owner and self._owner != owner:
            return False
        self._owner = owner
        return True

    def release(self, owner):
        """释放 owner 持有的资源，并通知等待方。"""
        if self._owner != owner:
            return False
        self._owner = ''
        self.released.emit(owner)
        return True

    @property
    def owner(self):
        """返回当前资源持有者，空字符串表示空闲。"""
        return self._owner
