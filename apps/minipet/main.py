# coding:utf-8
import os
import signal
import sys

from tendo import singleton
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication

APP_DIR = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(APP_DIR, 'src')
os.chdir(APP_DIR)
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

from app import main


if __name__ == '__main__':
    try:
        me = singleton.SingleInstance()
    except singleton.SingleInstanceException:
        print('MiniPet 已经在运行，已取消本次重复启动。')
        sys.exit(0)
    except BaseException as exc:
        print('MiniPet 启动锁检查失败：%s' % exc)
        sys.exit(1)

    QApplication.setHighDpiScaleFactorRoundingPolicy(Qt.HighDpiScaleFactorRoundingPolicy.PassThrough)
    # Qt 事件循环是 C++ 层在跑，Python 的 Ctrl+C 处理会被饿死，
    # 进程关不掉、后台堆积出多实例。恢复系统默认：Ctrl+C 直接结束进程。
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    main()
