# coding:utf-8
"""可配置的全局触发器：鼠标中键或单个键盘按键。

hotkey 字符串格式：
- 'mouse:middle' / 'mouse:x1' / 'mouse:x2' → 对应鼠标按键
- 'key:<名称>'  → 键盘特殊键（pynput Key 枚举名，如 f8、scroll_lock）
- 'char:<字符>' → 键盘字符按键（如 char:h）

默认 'mouse:middle'，与历史的中键行为一致。
"""

from PySide6.QtCore import QObject, Signal

from log_util import get_logger
from pynput import keyboard, mouse

log = get_logger('voice.trigger')

_MOUSE_NAMES = {'middle': '鼠标中键', 'x1': '鼠标侧键1', 'x2': '鼠标侧键2'}


def normalize_key(key):
    """把 pynput 键盘按键对象转成可存储/比较的热键字符串。"""
    name = getattr(key, 'name', None)
    if name:
        return 'key:%s' % name
    char = getattr(key, 'char', None)
    if char:
        return 'char:%s' % char
    return None


def normalize_button(button):
    """把 pynput 鼠标按键对象转成可存储/比较的热键字符串。"""
    return 'mouse:%s' % getattr(button, 'name', button)


def hotkey_display(hotkey):
    """热键字符串 → 界面展示文本。"""
    kind, _, value = str(hotkey or '').partition(':')
    if kind == 'mouse':
        return _MOUSE_DISPLAY.get(value, value)
    if kind == 'key':
        return value.upper()
    if kind == 'char':
        return '键:%s' % value
    return str(hotkey)


_MOUSE_DISPLAY = {'middle': '鼠标中键', 'x1': '鼠标侧键1', 'x2': '鼠标侧键2'}


class HotkeyTrigger(QObject):
    """全局触发器：配置的热键每次按下发一次 triggered 信号。

    监听器跑在 pynput 的后台线程里，信号跨线程投递到主线程。
    """

    triggered = Signal(int, int)

    def __init__(self, hotkey='mouse:middle', parent=None):
        super().__init__(parent)
        self.hotkey = hotkey or 'mouse:middle'
        self._mouse_listener = None
        self._key_listener = None

    def start(self):
        if self.hotkey.startswith('mouse:'):
            button_name = self.hotkey.partition(':')[2]

            def on_click(x, y, button, pressed):
                if pressed and button.name == button_name:
                    self.triggered.emit(int(x), int(y))

            self._mouse_listener = mouse.Listener(on_click=on_click)
            self._mouse_listener.start()
        else:
            target = self.hotkey

            def on_press(key):
                candidate = normalize_key(key)
                # 修饰键类按键记录到日志：AltGr 类触发键在部分驱动下
                # 事件名与录制时不一致，靠这行日志对账
                if candidate and candidate.startswith('key:'):
                    log.info('触发器收到按键: %s (目标 %s)', candidate, self.hotkey)
                if candidate == target:
                    self.triggered.emit(0, 0)

            self._key_listener = keyboard.Listener(on_press=on_press)
            self._key_listener.start()

    def stop(self):
        for listener in (self._mouse_listener, self._key_listener):
            if listener is not None:
                listener.stop()
        self._mouse_listener = None
        self._key_listener = None
