# coding:utf-8
"""后端流式文本的统一语义与状态管理。"""

from dataclasses import dataclass


@dataclass(frozen=True)
class TextEvent:
    """一条后端文本事件：传输形式与内容语义明确分离。"""
    text: str = ''
    mode: str = 'full'       # delta | full
    kind: str = 'final'      # final | progress | error
    terminal: bool = False
    result: bool = False
    success: object = None
    tts_eligible: bool = False


@dataclass(frozen=True)
class TextStreamUpdate:
    """accept 系列方法的返回值：当前快照 + 本次变更描述，供 UI 决定是否重绘/播报。"""
    text: str
    delta: str
    version: int
    changed: bool
    tts_safe: bool
    terminal: bool = False
    result: bool = False
    tts_eligible: bool = False


class TextStreamState:
    """把最终答复文本归一为单调完整快照，隔离 progress 与错误事件。"""

    def __init__(self):
        self.text = ''
        self.version = 0
        self.terminal = False

    def accept(self, event):
        """事件总入口：非 final 事件只透传 terminal/result 标记，不改动文本。"""
        if event.kind != 'final':
            return TextStreamUpdate(
                self.text, '', self.version, False, False,
                terminal=event.terminal, result=event.result,
                tts_eligible=False,
            )
        if event.mode == 'delta':
            return self.accept_delta(event.text, event=event)
        return self.accept_full(event.text, event=event)

    def accept_delta(self, text, event=None):
        """追加增量文本；已终态或空增量时忽略。"""
        if self.terminal or not text:
            return self._unchanged(event)
        self.text += text
        self.version += 1
        return self._update(text, True, True, event)

    def accept_full(self, text, terminal=False, event=None):
        """接受完整快照：只允许文本单调增长（旧文本是新文本的前缀），防止后端乱序回退。"""
        if event is None:
            event = TextEvent(text=text, mode='full', terminal=terminal)
        text = (text or '').strip()
        if self.terminal and not event.result:
            return self._unchanged(event)
        if text == self.text:
            if event.terminal:
                self.terminal = True
            return self._unchanged(event, tts_safe=True)
        if text and self.text.startswith(text) and not event.result:
            # 新文本是旧文本的前缀（内容回退），丢弃以维持单调性
            return self._unchanged(event)
        is_extension = text.startswith(self.text)
        if not is_extension and not event.result:
            return self._unchanged(event)
        delta = text[len(self.text):] if is_extension else ''
        self.text = text
        self.version += 1
        if event.terminal:
            self.terminal = True
        return self._update(delta, True, is_extension, event)

    def _unchanged(self, event=None, tts_safe=False):
        """构造“文本未变化”的返回值，仅同步事件标记。"""
        return TextStreamUpdate(
            self.text, '', self.version, False, tts_safe,
            terminal=bool(event and event.terminal),
            result=bool(event and event.result),
            tts_eligible=bool(event and event.tts_eligible),
        )

    def _update(self, delta, changed, tts_safe, event):
        """构造“文本已更新”的返回值，携带本次增量。"""
        return TextStreamUpdate(
            self.text, delta, self.version, changed, tts_safe,
            terminal=bool(event and event.terminal),
            result=bool(event and event.result),
            tts_eligible=bool(event and event.tts_eligible),
        )
