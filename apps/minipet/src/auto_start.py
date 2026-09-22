# coding:utf-8
"""开机自启：写入当前用户注册表 Run 键（无需管理员权限）。

仅支持 Windows；其他平台上的操作为空操作。
自启命令用 pythonw（无控制台黑窗），并以绝对路径启动 main.py，
因此不依赖工作目录，也不依赖启动时的终端。
"""

import os
import sys

APP_KEY = 'MiniPet'
_RUN_KEY = r'Software\Microsoft\Windows\CurrentVersion\Run'


def _launch_command():
    """构造自启命令：优先 pythonw（无控制台窗口），绝对路径启动 main.py。"""
    pythonw = os.path.join(os.path.dirname(sys.executable), 'pythonw.exe')
    if not os.path.isfile(pythonw):
        pythonw = sys.executable  # 个别安装缺 pythonw 时的兜底
    main_py = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'main.py')
    return '"%s" "%s"' % (pythonw, main_py)


def is_enabled():
    """查询开机自启是否已启用（以注册表为准）。"""
    if sys.platform != 'win32':
        return False
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_READ) as key:
            value, _type = winreg.QueryValueEx(key, APP_KEY)
        return bool(value)
    except OSError:
        return False


def set_enabled(enabled):
    """开启/关闭开机自启。关闭时条目不存在则静默跳过。"""
    if sys.platform != 'win32':
        return
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
        if enabled:
            winreg.SetValueEx(key, APP_KEY, 0, winreg.REG_SZ, _launch_command())
        else:
            try:
                winreg.DeleteValue(key, APP_KEY)
            except FileNotFoundError:
                pass
