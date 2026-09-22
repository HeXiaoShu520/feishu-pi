# coding:utf-8
"""MiniPet surface 卡片事件的纯数据辅助函数。

surface payload 结构因 Agent 实现不同而差异较大（有的用 text，有的用 elements 数组）；
这里统一抽取逻辑，避免散落在各处的重复判断。
纯函数设计，不依赖 Qt，方便单元测试。
"""


# 这些过渡性提示文字不值得触发 TTS 朗读，屏蔽掉可减少噪音
SILENT_SURFACE_TEXTS = {'我在处理...', '我在处理…', '正在处理...', '正在处理…', '处理中...', '处理中…'}

# 一旦 status 落入终态，卡片应尽快自动关闭
TERMINAL_SURFACE_STATUSES = {'done', 'completed', 'complete', 'success', 'failed', 'failure', 'error'}

# 富文本 elements 中哪些 tag/type 算"文字内容"
TEXT_ELEMENT_TYPES = {'markdown', 'text', 'plain_text', 'code'}


def surface_text(payload):
    """从 surface payload 中提取适合展示和语音播报的主文本。

    优先取顶层 text/message/summary/content 字段；
    没有时再拼接 elements 数组里的文字节点，换行分隔。
    """
    text = payload.get('text') or payload.get('message') or payload.get('summary') or payload.get('content') or ''
    if text:
        return str(text).strip()
    parts = []
    for element in payload.get('elements') or []:
        if not isinstance(element, dict):
            continue
        tag = element.get('tag') or element.get('type')
        if tag in TEXT_ELEMENT_TYPES:
            content = element.get('content') or element.get('text') or ''
            if content:
                parts.append(str(content))
    return '\n'.join(parts).strip()


def is_silent_surface_text(text):
    return not text or text in SILENT_SURFACE_TEXTS


def surface_text_mode(payload):
    mode = str(payload.get('text_mode') or 'full').strip().lower()
    return mode if mode in ('delta', 'full') else 'full'


def surface_content_kind(payload):
    kind = str(payload.get('content_kind') or 'final').strip().lower()
    return kind if kind in ('final', 'progress') else 'final'


def surface_tts_eligible(payload):
    if surface_content_kind(payload) != 'final':
        return False
    return bool(payload.get('tts_eligible', True))


def is_terminal_surface_status(payload):
    status = str(payload.get('status') or payload.get('state') or '').strip().lower().replace('_', '-')
    return status in TERMINAL_SURFACE_STATUSES


def surface_timeout(payload):
    # 终态卡片默认 6 秒后关闭，非终态保留 60 秒等待后续 update
    if payload.get('timeout_ms') is not None:
        return int(payload.get('timeout_ms') or 0)
    lifetime = payload.get('lifetime') if isinstance(payload.get('lifetime'), dict) else {}
    if lifetime.get('ttl_ms') is not None:
        return int(lifetime.get('ttl_ms') or 0)
    if payload.get('timeout') is not None:
        return int(float(payload.get('timeout') or 0) * 1000)
    return 6000 if is_terminal_surface_status(payload) else 60000


def normalize_display_event(event_type, payload):
    event = dict(payload)
    event['type'] = event_type
    event.setdefault('summary', event.get('content') or event.get('description') or '')
    return event
