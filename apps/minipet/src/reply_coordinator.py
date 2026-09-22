# coding:utf-8
"""对话轮次（Turn）生命周期管理。

从 MiniPetApp 中拆出的回复编排逻辑，以 mixin 形式被 MiniPetApp 继承使用；
self 仍是 MiniPetApp 实例，直接访问其持有的 turn 注册表、流式延迟队列、
回复卡片与聊天窗口等成员。

职责：
- TurnContext：一轮对话的全部上下文（后端/来源/卡片/回调/流式状态）
- turn 注册与解析：_begin_turn / _resolve_turn
- 流式文本的归一化与发布：_accept_turn_text / _publish_turn_update
- 轮次收尾：_finish_turn（聊天窗口回调 vs 外部请求落盘两条路径）
"""

import uuid
from dataclasses import dataclass, field

from text_stream import TextEvent, TextStreamState, TextStreamUpdate


@dataclass
class TurnContext:
    """一轮对话的上下文。surface_id 对应回复卡片，origin 区分 chat_window 和 external。"""
    turn_id: str
    backend: str      # 目前固定为 minipet
    session_id: str   # 对应后端的全局会话 ID
    origin: str       # 'chat_window' | 'external'
    surface_id: str   # 回复卡片 ID
    source: str       # 触发来源：quick_chat / voice_chat / reply_card_quote 等
    on_delta: object = None   # 聊天窗口 delta 回调
    on_result: object = None  # 聊天窗口 result 回调
    text: str = ''
    stream: TextStreamState = field(default_factory=TextStreamState)


class ReplyTurnMixin:
    """MiniPetApp 的轮次生命周期 mixin：不持有状态，全部经 self 访问主应用。"""

    # ==== TurnContext 生命周期 ====
    def _begin_turn(self, backend, origin, session_id='', source='quick_chat', surface_id='', on_delta=None, on_result=None):
        """开始一轮对话，生成 turn_id 并注册到活跃 turn 字典。"""
        turn_id = str(uuid.uuid4())
        surface_id = surface_id or 'turn-' + turn_id
        turn = TurnContext(turn_id, backend, session_id, origin, surface_id, source, on_delta, on_result)
        self._active_turns[turn_id] = turn
        self._turn_by_surface_id[surface_id] = turn_id
        return turn

    def _resolve_turn(self, backend, turn_id='', surface_id=''):
        """按 turn_id / surface_id 找回活跃 turn；找不到时从单候选中匹配。"""
        turn = self._active_turns.get(turn_id) if turn_id else None
        if turn is None and surface_id:
            turn = self._active_turns.get(self._turn_by_surface_id.get(surface_id, ''))
        if turn is None:
            candidates = [item for item in self._active_turns.values() if item.backend == backend]
            if len(candidates) == 1:
                turn = candidates[0]
        return turn if turn and turn.backend == backend else None

    def _turn_lane(self, turn):
        """返回流式延迟队列的 lane 标识（backend:turn_id）。"""
        return '%s:%s' % (turn.backend, turn.turn_id)

    def _accept_turn_text(self, turn, text, mode='full', terminal=False,
                          result=False, tts_eligible=False, kind='final'):
        """立即归一化后端文本；UI 延迟仅消费返回的不可变快照。"""
        if not turn:
            return TextStreamUpdate('', '', 0, False, False)
        event = TextEvent(
            text=text, mode=mode, kind=kind, terminal=terminal,
            result=result, tts_eligible=tts_eligible,
        )
        update = turn.stream.accept(event)
        turn.text = update.text
        return update

    def _publish_turn_update(self, turn, update):
        """展示已归一化的流式快照，不再推断 delta/full 语义。"""
        if not turn or not update.changed:
            return
        if turn.origin == 'chat_window':
            if update.delta and turn.on_delta:
                turn.on_delta(update.delta)
            return
        self._hide_thinking_orb()
        self._show_reply_card(update.text, status='streaming', timeout_ms=60000, result_usage=self._quick_reply_usage)

    def _publish_turn_delta(self, turn, text):
        """兼容旧调用：文本按完整快照处理。"""
        self._publish_turn_update(turn, self._accept_turn_text(turn, text, mode='full'))

    def _queue_turn_update(self, turn, update):
        """把流式快照排入延迟队列，防止高频 delta 闪烁 UI。"""
        if not update.changed:
            return
        self.stream_display_delay.enqueue(
            self._turn_lane(turn),
            lambda: self._publish_turn_update(turn, update),
            version=update.version if turn.origin != 'chat_window' else None,
        )

    def _refresh_chat_window_for_turn(self, turn):
        """如果聊天窗口显示的正是这个 turn 的后端，则刷新历史。"""
        window = self.pet.chat_window
        if (window is not None and window.isVisible()
                and window.backend == turn.backend
                and turn.session_id == self._backend_session_id(turn.backend)):
            window.reload_history()

    def _is_external_chat_window_turn(self, backend):
        """判断当前指定后端是否正在服务聊天窗口的请求。"""
        turn = self._resolve_turn(backend)
        return bool(turn and turn.origin == 'chat_window')

    def _cancel_current_reply_workers(self):
        """voice_controller.pause() 调用：取消当前 mini-claw 轮次。"""
        self.router.cancel_workers()

    def _finish_turn(self, turn, success, text=''):
        """结束一轮对话：UI 只收终态，历史由 mini-claw 内核统一持久化。"""
        if not turn or self._active_turns.pop(turn.turn_id, None) is None:
            return False
        self._turn_by_surface_id.pop(turn.surface_id, None)
        # text 是外部显式传入的最终文本，turn.text 是流式累积值
        final = (text or turn.text).strip()
        if turn.origin == 'chat_window':
            if turn.on_result:
                turn.on_result(success, final)
            return True
        self._hide_thinking_orb()
        if success and final:
            self._refresh_chat_window_for_turn(turn)
        return True

    def _chat_window_delta(self, backend, text):
        """聊天窗口后端的 delta 路由。"""
        turn = self._resolve_turn(backend)
        if turn and turn.origin == 'chat_window':
            self._publish_turn_delta(turn, text)

    def _chat_window_result(self, backend, success, text):
        """聊天窗口后端的 result 路由。"""
        turn = self._resolve_turn(backend)
        if not turn or turn.origin != 'chat_window':
            return False
        return self._finish_turn(turn, success, text)

    def _save_external_reply(self, backend, reply):
        """旧调用入口：历史已由 mini-claw 持久化，这里只结束 UI 轮次。"""
        turn = self._resolve_turn(backend)
        if turn:
            self._finish_turn(turn, True, reply)
