# coding:utf-8
"""通知管理器。

ReplyCardCenter 是所有回复卡片和 Toast 的统一调度入口。
新卡片进来时自动入栈，超出上限时关闭最旧的，所有卡片位置在增删后重排。
锚点（宠物位置）更新时，所有未被手动拖拽的卡片会平滑跟随移动。
"""

import uuid

from PySide6.QtCore import QPoint, QUrl, Signal
from PySide6.QtGui import QPixmap
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtWidgets import QApplication, QWidget

import config
from widgets.notifications.constants import CARD_BASE_GAP, CARD_STACK_GAP, MAX_STACKED_REPLY_CARDS, REPLY_CARD_TIMEOUT_MS
from widgets.notifications.reply_card import ReplyCard
from widgets.notifications.toast import Toast


class ReplyCardCenter(QWidget):
    """回复卡片管理器，负责创建、堆叠、移动和关闭短生命周期卡片。"""

    reply_card_action_clicked = Signal(dict, dict)
    reply_card_interrupted = Signal(str)
    reply_card_mute_tts = Signal(str)
    reply_card_quote_submitted = Signal(str, object, str, str)  # card_id, full_message_or_content, quoted_text, user_text

    def __init__(self, parent=None):
        """初始化卡片/Toast 容器和通知音效播放器。"""
        super().__init__(parent)
        self.toasts = {}
        self.reply_cards = {}
        self.reply_card_order = []
        self.reply_card_anchor = None
        self.audio = QMediaPlayer(self)
        self.audio_output = QAudioOutput(self)
        self.audio.setAudioOutput(self.audio_output)

    def setup_toast(self, title, message='', icon_path=None):
        """创建 Toast 通知并按已有 Toast 总高度向下偏移叠放，同时播放提示音。"""
        note_id = str(uuid.uuid4())
        icon = QPixmap(icon_path) if icon_path else QPixmap(str(config.avatar_path('pet')))
        toast = Toast(note_id, title, message, icon)
        toast.closed.connect(self._remove_toast)
        offset = sum(t.height() + 10 for t in self.toasts.values())
        self.toasts[note_id] = toast
        toast.show_at(offset)
        self._play_sound()

    def setup_reply_card_text(self, message, x, y, timeout=6000, title=None):
        """创建纯文本终态回复卡片的便捷入口。"""
        title = title or config.APP_DISPLAY_NAME
        card_id = str(uuid.uuid4())
        card = ReplyCard(card_id, {
            'type': 'surface.show',
            'content': message,
            'title': title,
            'avatar_kind': 'user' if title == '你' else 'pet',
            'status': 'done',
        }, timeout)
        card.interrupted.connect(self.reply_card_interrupted)
        card.layout_changed.connect(lambda cid=card_id: self._reflow_reply_cards(animate=True, skip_id=cid))
        card.closed.connect(self._remove_reply_card)
        self._register_reply_card(card_id, card, x, y)
        return card_id

    def close_reply_card(self, card_id):
        card = self.reply_cards.get(card_id)
        if card is not None:
            card.request_close()

    def set_reply_card_tts_active(self, card_id, active):
        card = self.reply_cards.get(card_id)
        if card is not None and hasattr(card, 'set_tts_active'):
            card.set_tts_active(active)

    def update_reply_card(self, card_id, message, timeout=None):
        card = self.reply_cards.get(card_id)
        if card is None:
            return False
        old_size = card.size()
        if isinstance(message, dict) and hasattr(card, 'update_card'):
            card.update_card(message, timeout=timeout)
        elif hasattr(card, 'update_message'):
            card.update_message(message, timeout=timeout)
        else:
            return False
        if card.size() != old_size:
            self._reflow_reply_cards(animate=True)
        return True

    def setup_reply_card(self, event, x, y, play_sound=True):
        """根据 surface.show 事件创建完整回复卡片并接入各回调信号。"""
        card_id = str(uuid.uuid4())
        timeout = int(event.get('timeout_ms', REPLY_CARD_TIMEOUT_MS) or 0)
        card = ReplyCard(card_id, event, timeout)
        card.action_clicked.connect(self.reply_card_action_clicked)
        card.interrupted.connect(self.reply_card_interrupted)
        card.mute_tts.connect(self.reply_card_mute_tts)
        card.quote_reply_submitted.connect(self.reply_card_quote_submitted)
        card.layout_changed.connect(lambda cid=card_id: self._reflow_reply_cards(animate=True, skip_id=cid))
        card.closed.connect(self._remove_reply_card)
        self._register_reply_card(card_id, card, x, y)
        if play_sound:
            self._play_sound()
        return card_id

    def _register_reply_card(self, card_id, card, x, y):
        # 注册新卡片：先确定目标位置，再裁剪超额旧卡片，最后重排已有卡片，
        # skip_id 防止新卡片在自己的入场动画期间被 reflow 意外移位
        self.reply_card_anchor = QPoint(int(x), int(y))
        self.reply_cards[card_id] = card
        self.reply_card_order.append(card_id)
        target = self._reply_card_target_pos(card, 0, self.reply_card_anchor)
        self._trim_reply_cards()
        self._reflow_reply_cards(animate=True, skip_id=card_id)
        card.animate_in(target)

    def _reply_card_target_pos(self, card, stack_index, anchor):
        """计算指定堆叠层的卡片位置：水平居中于锚点，向上按层偏移，最后裁剪到屏幕内。"""
        x = int(anchor.x() - card.width() / 2)
        y = int(anchor.y() - card.height() - CARD_BASE_GAP)
        return self._clamp_to_anchor_screen(QPoint(x, y - stack_index * (card.height() + CARD_STACK_GAP)), card, anchor)

    def _clamp_to_anchor_screen(self, pos, widget, anchor, margin=4):
        """把位置限制在锚点所在屏幕的可用区域内，留 margin 像素安全边距。"""
        screen = QApplication.screenAt(anchor) or QApplication.primaryScreen()
        if screen is None:
            return pos
        area = screen.availableGeometry()
        x = max(area.left() + margin, min(pos.x(), area.right() - widget.width() - margin))
        y = max(area.top() + margin, min(pos.y(), area.bottom() - widget.height() - margin))
        return QPoint(x, y)

    def _active_reply_card_ids(self):
        self.reply_card_order = [cid for cid in self.reply_card_order if cid in self.reply_cards]
        return [cid for cid in self.reply_card_order if not getattr(self.reply_cards[cid], 'closing', False)]

    def _trim_reply_cards(self):
        # 超出最大堆叠数时，从最旧的卡片开始关闭，保持界面整洁不堆满屏幕
        active_ids = self._active_reply_card_ids()
        overflow = len(active_ids) - MAX_STACKED_REPLY_CARDS
        if overflow <= 0:
            return
        for card_id in active_ids[:overflow]:
            card = self.reply_cards.get(card_id)
            if card is not None:
                card.request_close()

    def _reflow_reply_cards(self, animate=True, skip_id=None):
        # 重新计算所有活跃卡片的堆叠位置，最新卡片在最下方（stack_index=0），
        # 手动拖拽过的卡片保留用户位置，不参与自动重排
        if self.reply_card_anchor is None:
            return
        active_ids = self._active_reply_card_ids()
        for stack_index, card_id in enumerate(reversed(active_ids)):
            if card_id == skip_id:
                continue
            card = self.reply_cards[card_id]
            if getattr(card, 'manual_position', False):
                continue
            target = self._reply_card_target_pos(card, stack_index, self.reply_card_anchor)
            if animate:
                card.animate_to(target)
            else:
                card.move(target)

    def _remove_toast(self, note_id):
        self.toasts.pop(note_id, None)

    def _remove_reply_card(self, card_id):
        self.reply_cards.pop(card_id, None)
        self.reply_card_order = [cid for cid in self.reply_card_order if cid != card_id]
        self._reflow_reply_cards(animate=True)

    def _play_sound(self):
        sound = config.RES_DIR / 'sounds' / 'Notification.wav'
        if not sound.exists():
            return
        self.audio_output.setVolume(float(config.app_config.get('volume', 0.4)))
        self.audio.setSource(QUrl.fromLocalFile(str(sound)))
        self.audio.play()
