# coding:utf-8
"""终端日志文本预览工具。"""


DEFAULT_LOG_PREVIEW_CHARS = 300


def log_preview(value, limit=DEFAULT_LOG_PREVIEW_CHARS):
    """返回适合单行终端日志的受限文本预览。"""
    text = str(value or '').replace('\r', '\\r').replace('\n', '\\n')
    if len(text) <= limit:
        return text
    return '%s... [已省略 %s 字符]' % (text[:limit], len(text) - limit)
