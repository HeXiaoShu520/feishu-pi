# coding:utf-8
"""MiniPet 与 mini-claw 的本地 JSONL 协议常量。"""

PROTOCOL = 'minipet.v1'

# 会话生命周期事件
SESSION_HELLO = 'session.hello'
SESSION_READY = 'session.ready'

# 业务事件
USER_INPUT = 'user.input'
USER_CANCEL = 'user.cancel'
USER_APPROVAL = 'user.approval'
HISTORY_GET = 'history.get'
HISTORY_RESULT = 'history.result'
HISTORY_CLEAR = 'history.clear'
HISTORY_CLEARED = 'history.cleared'
SURFACE_SHOW = 'surface.show'
SURFACE_UPDATE = 'surface.update'
SURFACE_CLOSE = 'surface.close'

# 握手时声明的能力列表（不含 AGENT_STATE，因其属于宠物端单向推送）
V1_CAPABILITIES = [
    SESSION_HELLO,
    SESSION_READY,
    USER_INPUT,
    USER_CANCEL,
    USER_APPROVAL,
    HISTORY_GET,
    HISTORY_RESULT,
    HISTORY_CLEAR,
    HISTORY_CLEARED,
    SURFACE_SHOW,
    SURFACE_UPDATE,
    SURFACE_CLOSE,
]


def normalize_inbound_event(event):
    if not isinstance(event, dict):
        return {
            'version': '1.0',
            'type': 'error',
            'payload': {
                'code': 'invalid_envelope',
                'message': '内核返回了非对象协议消息',
            },
        }
    data = dict(event)
    if data.get('version', '1.0') != '1.0':
        return {
            'version': '1.0',
            'type': 'error',
            'payload': {'code': 'unsupported_protocol', 'message': '内核返回了不支持的协议版本'},
        }
    if data.get('type') not in V1_CAPABILITIES and data.get('type') != 'error':
        return {
            'version': '1.0',
            'type': 'error',
            'payload': {'code': 'unsupported_type', 'message': '内核返回了未声明的消息类型'},
        }
    if not isinstance(data.get('payload'), dict):
        return {
            'version': '1.0',
            'type': 'error',
            'payload': {'code': 'invalid_payload', 'message': '内核返回的 payload 必须是对象'},
        }
    data['version'] = '1.0'
    data.setdefault('payload', {})
    return data


def hello_payload(client=None):
    payload = {
        'protocol': PROTOCOL,
        'capabilities': list(V1_CAPABILITIES),
    }
    if isinstance(client, dict):
        payload['client'] = dict(client)
    return payload


def history_payload(session_id):
    """历史请求/清理共用的稳定会话标识。"""
    return {'session_id': str(session_id or 'minipet:global')}


