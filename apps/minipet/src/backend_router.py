# coding:utf-8
"""mini-claw 唯一后端适配器。

MiniPet 只负责桌面交互；模型、会话、工具和权限全部由 mini-claw Node 内核处理。
这里保留一个很薄的路由层，只负责把桌面输入送进 minipet.v1，并提供统一的
中断入口，避免桌面层重新实现任何 Agent 逻辑。
"""

from PySide6.QtCore import QObject

from protocols.protocol_v1 import USER_INPUT


class BackendRouter(QObject):
    """将所有请求固定发送到 mini-claw 本地 JSONL 通道。"""

    backend = 'minipet'

    def __init__(self, app, parent=None):
        super().__init__(parent)
        self._app = app

    def send(self, content, mode='text', surface='pet_popup', screenshot='',
             attachments=None, turn_id='', surface_id='', session_id='', extra=None):
        """发送一条结构化输入；不在桌面端构造模型消息或执行模型调用。"""
        events = self._app.events
        payload = self._app._user_input_payload(
            content, mode=mode, surface=surface, screenshot=screenshot,
            attachments=attachments,
        )
        if turn_id:
            payload['turn_id'] = turn_id
        if surface_id:
            payload['surface_id'] = surface_id
        if session_id:
            payload['session_id'] = session_id
        if extra:
            payload.update(extra)

        if events is not None and not events.isRunning():
            events.running = True
            events.start()

        sent = events.send_event(USER_INPUT, payload) if events else False
        if not sent:
            self._app._show_backend_error('mini-claw 尚未连接，请确认 mini-claw 服务已启动。')
        return sent

    def cancel_workers(self):
        """统一中断入口；真正的会话中断由 mini-claw ConversationManager 执行。"""
        return None

    def shutdown(self):
        """路由层没有独立 worker，保留统一生命周期接口。"""
        return None
