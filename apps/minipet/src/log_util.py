# coding:utf-8
"""应用日志工具：统一格式与输出，替代散落在各模块的 print 调试输出。

用法：
    from log_util import get_logger
    log = get_logger('voice.chat')
    log.info('进入录音状态')

日志格式：[时间.毫秒] [模块名] 消息，输出到 stdout；
应用入口（app.main）调用 setup_logging() 后全局生效。
"""

import logging
import os
import sys

# 防止重复初始化根 logger 时叠加 handler，导致同一条日志打印多次
_CONFIGURED = False

# 统一日志格式：本地时间精确到毫秒，附带模块名便于过滤
_FORMAT = '[%(asctime)s.%(msecs)03d] [%(name)s] %(message)s'
_DATEFMT = '%Y-%m-%d %H:%M:%S'


class _BenignHttpStreamNoiseFilter(logging.Filter):
    """过滤 httpx2/httpcore2 分支库关闭流式响应时的已知无害报错。

    流式 HTTP 客户端收到结束标记后停止读取，HTTP 体残留的尾字节在连接
    归还时可能触发生成器清理瑕疵（RuntimeError: generator didn't stop
    after athrow()）。业务结果不受影响，属纯噪音。
    """

    _MARKERS = (
        'an error occurred during closing of asynchronous generator',
        "generator didn't stop after athrow()",
    )

    def filter(self, record):
        try:
            message = record.getMessage()
        except Exception:
            return True
        return not any(marker in message for marker in self._MARKERS)


def setup_logging(level=logging.INFO):
    """初始化根 logger（幂等，重复调用无副作用）。

    日志同时输出到控制台和滚动文件（pythonw 静默启动时控制台不存在，
    文件是唯一的日志出口）；文件按 1MB 轮转，保留 3 份备份。
    """
    global _CONFIGURED
    if _CONFIGURED:
        return
    formatter = logging.Formatter(_FORMAT, _DATEFMT)

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(formatter)
    console.addFilter(_BenignHttpStreamNoiseFilter())
    root = logging.getLogger()
    root.addHandler(console)

    try:
        from handlers import RotatingFileHandler
    except ImportError:
        from logging.handlers import RotatingFileHandler
    log_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'logs')
    os.makedirs(log_dir, exist_ok=True)
    file_handler = RotatingFileHandler(os.path.join(log_dir, 'minipet.log'),
                                       maxBytes=1_000_000, backupCount=3, encoding='utf-8')
    file_handler.setFormatter(formatter)
    file_handler.addFilter(_BenignHttpStreamNoiseFilter())
    root.addHandler(file_handler)

    root.setLevel(level)
    _CONFIGURED = True


def get_logger(name):
    """返回命名 logger；未初始化时先按默认级别初始化，保证模块可独立运行。"""
    if not _CONFIGURED:
        setup_logging()
    return logging.getLogger(name)
