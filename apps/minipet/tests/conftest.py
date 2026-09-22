# coding:utf-8
"""测试全局配置：Qt 界面测试强制使用离屏平台。

不设置的话，创建 QApplication 的测试会在真实屏幕上闪现窗口
（如回复卡片测试的'旧内容'素材卡），干扰正常使用。
"""

import os

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
