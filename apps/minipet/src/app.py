# coding:utf-8
"""
MiniPet 应用组装入口。

MiniPetApp 是整个桌宠程序的协调层，负责把各模块串联起来：
  - 桌宠窗口（DesktopPet）与设置窗口（SettingsWindow）
  - 内核历史投影与回复卡片（ReplyCardCenter）
  - 语音聊天（VoiceController：ASR / 唤醒词 / TTS）
  - mini-claw 本地 JSONL 事件（唯一内核后端）
  - 日常定时输入（DailyInputController）

这里只保留跨模块的信号连接和 Surface（回复卡片）的显示逻辑；
TurnContext 轮次生命周期在 reply_coordinator（以 mixin 注入），
语音、日常输入、后端路由等业务实现在各自模块中。
"""

import base64
import json
import mimetypes
import signal
import sys
from pathlib import Path

from PySide6.QtCore import QLocale, QTimer
from PySide6.QtGui import QFont, QGuiApplication
from PySide6.QtWidgets import QApplication
from qfluentwidgets import FluentTranslator, setThemeColor

import config
from log_util import get_logger, setup_logging
from pet.desktop_pet import DesktopPet
from clients.event_client import EventClient
from widgets.notifications.reply_card_center import ReplyCardCenter
from protocols.protocol_v1 import (
    HISTORY_RESULT,
    SESSION_READY,
    SURFACE_CLOSE, SURFACE_SHOW, SURFACE_UPDATE,
    normalize_inbound_event,
)
from protocols.surface_utils import (
    is_silent_surface_text, is_terminal_surface_status,
    normalize_display_event, surface_text,
    surface_timeout, surface_tts_eligible,
)
from settings_window import SettingsWindow
from clients.stream_tts import StreamTtsQueue
from stream_display_delay import StreamDisplayDelay
from clients.tts_client import TtsPreviewWorker, stop_tts
from daily_input_controller import DailyInputController
from widgets.daily_input_bar import DailyInputBar
from voice_controller import VoiceController
from audio_resource_coordinator import AudioResourceCoordinator
from backend_router import BackendRouter
from reply_coordinator import ReplyTurnMixin


# 启动/退出 TTS 之后，再显示对应问候卡片的延迟（让 TTS 先开始播放）
EVENT_CARD_AFTER_TTS_START_DELAY_MS = 450
# 退出问候卡片停留时间（无 TTS 时）
GOODBYE_CARD_QUIT_DELAY_MS = 1800


log = get_logger('app')


class MiniPetApp(QApplication, ReplyTurnMixin):
    """MiniPet 主应用：跨模块协调层。

    不直接绘制 UI，而是通过 Qt 信号把各模块的事件串联起来：
    - 桌宠交互 → 发送 mini-claw / 语音请求
    - mini-claw/TTS 结果 → 更新回复卡片 / 语音球
    - 设置变更 → 重新加载后端/唤醒词配置
    - mini-claw 内核事件 → Surface 卡片显示

    关键子系统（都是 QObject，生命周期由此管理）：
    - VoiceController：语音录制、唤醒词、TTS 回调
    - BackendRouter：mini-claw 请求发送
    - StreamTtsQueue × 2：本地输入/内核回复 TTS 管道
    - StreamDisplayDelay：防止 UI 闪烁的延迟队列
    """

    def __init__(self, argv, start_event_client=True):
        super().__init__(argv)
        self.setQuitOnLastWindowClosed(False)
        config.load()
        self.setFont(QFont('Microsoft YaHei UI'))
        locale_code = config.app_config.get('language_code', 'zh_CN')
        self.installTranslator(FluentTranslator(QLocale(locale_code)))
        if config.app_config.get('theme_color'):
            setThemeColor(config.app_config['theme_color'])

        # 多屏：把主屏排在最前，桌宠初始定位和找回优先参考主屏
        screens = self.screens()
        primary = self.primaryScreen()
        if primary in screens:
            screens.insert(0, screens.pop(screens.index(primary)))

        # ---------- 核心对象 ----------
        self.pet = DesktopPet(screens)
        self.settings = SettingsWindow()
        self.note = ReplyCardCenter()
        self.daily_input_bar = DailyInputBar()
        self.audio_resources = AudioResourceCoordinator(self)
        self._daily_input_ctrl = DailyInputController(
            app=self, audio_resources=self.audio_resources, parent=self,
        )

        # EventClient：MiniPet 内置前端唯一后端
        self.events = EventClient() if start_event_client else None
        # ---------- 聊天历史 ----------
        # 唯一事实来源是 mini-claw 的 Pi session 文件；桌面端只保留当前展示快照。
        self.chat_session_id = 'minipet:global'
        self.chat_histories = {'minipet': []}
        self.chat_history = []

        # ---------- 快速聊天状态 ----------
        # quick_chat_* 跟踪当前正在进行的快速输入/语音请求
        self.quick_chat_worker = None   # 兼容语音控制器的“在途请求”状态；实际请求由 mini-claw 管理
        self.quick_chat_source = 'quick_chat'   # 触发来源
        self.quick_reply_card_id = None         # 当前回复卡片 ID
        self._quick_stream_text = ''            # 流式累积文本
        self._quick_reply_usage = None          # 用量统计（token/cost）
        self.event_tts_worker = None            # 启动/退出音效 worker

        # ---------- 流式显示和 TTS ----------
        self.stream_display_delay = StreamDisplayDelay(self)
        # quick_stream_tts：保留前端语音播放管道，文本由 mini-claw 内核产生
        self.quick_stream_tts = StreamTtsQueue(
            self, label='TTS',
            on_started=self._on_quick_stream_tts_started,
            on_idle=self._finish_quick_voice_if_tts_idle,
        )
        # external_stream_tts：mini-claw 流式文本的 TTS 管道
        self.external_stream_tts = StreamTtsQueue(
            self, label='External TTS',
            on_started=self._on_external_stream_tts_started,
            on_idle=self._finish_external_voice_if_tts_idle,
        )

        # ---------- 子控制器 ----------
        self.voice = VoiceController(
            app=self,
            audio_resources=self.audio_resources,
            submit_voice_text=self._on_voice_text_confirmed,
            stop_all_tts=self._stop_all_tts,
            parent=self,
        )
        self.router = BackendRouter(app=self, parent=self)

        # ---------- 杂项状态 ----------
        self._active_turns = {}           # turn_id → TurnContext
        self._turn_by_surface_id = {}     # surface_id → turn_id
        self._surface_cards = {}          # surface_id → reply_card_id
        self._minipet_connected = False
        self._minipet_ready = False
        self.is_quitting = False
        self._shutdown_started = False
        self.startup_greeting_shown = False
        self.exit_card_shown = False
        self._thinking_orb_active = False # 快速输入时显示的思考球
        self._reuse_reply_card_pending = False  # 引用追问时复用原卡片

        # ---------- 信号连接 ----------
        self._connect_signals()

        if self.events and self._agent_backend() == 'minipet':
            self.events.start()
        self.voice.apply_wake_word_settings()
        self._daily_input_ctrl.apply_settings()
        self._pet_auto_switch_timer = QTimer(self)
        self._pet_auto_switch_timer.timeout.connect(self._on_pet_auto_switch)
        self._apply_pet_auto_switch()
        QTimer.singleShot(0, self._show_startup_greeting)

    def _connect_signals(self):
        """集中连接所有跨模块信号，方便维护。"""
        pet, settings, note = self.pet, self.settings, self.note

        # 桌宠交互
        pet.show_settings.connect(settings.show_window)
        pet.reply_card_text_requested.connect(
            lambda text, x, y, timeout: note.setup_reply_card_text(
                text, x, y, timeout, title=config.pet_display_name()
            )
        )
        pet.chat_prompt_submitted.connect(self._on_quick_chat_prompt)
        pet.drop_intent_submitted.connect(self._on_drop_intent)
        pet.chat_requested.connect(self._show_chat_window)
        pet.voice_chat_requested.connect(self._toggle_voice_orb)
        pet.voice_pause_requested.connect(self.voice.pause)
        pet.voice_stop_requested.connect(self.voice.stop)
        pet.share_screen_requested.connect(self.voice.set_screen_share)
        pet.quit_requested.connect(self._on_quit_requested)

        # 设置变更
        settings.settings_changed.connect(pet.apply_settings)
        settings.settings_changed.connect(
            lambda: self.voice.apply_wake_word_settings()
        )
        settings.settings_changed.connect(self._daily_input_ctrl.apply_settings)
        settings.settings_changed.connect(self._apply_pet_auto_switch)
        settings.pet_changed.connect(pet.load_pet)

        # 回复卡片事件
        note.reply_card_action_clicked.connect(self._on_reply_card_action)
        note.reply_card_interrupted.connect(self._on_reply_card_interrupted)
        note.reply_card_mute_tts.connect(self._on_reply_card_mute_tts)
        note.reply_card_quote_submitted.connect(self._on_reply_card_quote)

        # mini-claw 内核事件
        if self.events:
            self.events.event_received.connect(self._on_event)
            self.events.connection_changed.connect(self._on_event_connection_changed)
            self.events.ready_changed.connect(self._on_minipet_ready_changed)

    def _memory_message_limit(self):
        """旧版本地模型上下文限制已移交 mini-claw 内核。"""
        return 0

    def _restore_chat_history(self):
        """历史由内核握手后通过 history.result 下发，启动时只建立空展示快照。"""
        self.chat_history = self._history_for_backend(self._agent_backend())

    def _backend_session_id(self, backend):
        """返回桌面端绑定的稳定内核会话 ID。"""
        return self.chat_session_id

    def _history_for_backend(self, backend):
        """返回内核历史在桌面端的只读投影缓存。"""
        return self.chat_histories.setdefault(backend or 'minipet', [])

    def _refresh_chat_window(self):
        """如果聊天窗口当前可见，则重新加载以反映最新历史。"""
        if self.pet.chat_window is not None and self.pet.chat_window.isVisible():
            self._show_chat_window()

    def _agent_backend(self):
        """返回桌面端唯一的 mini-claw 内核通道。"""
        return 'minipet'

    # ==== 宠物模型自动轮换 ====
    def _apply_pet_auto_switch(self):
        """按配置维护自动轮换定时器；分钟数 <= 0 表示关闭。"""
        try:
            minutes = int(float(config.app_config.get('pet_auto_switch_minutes') or 0))
        except (TypeError, ValueError):
            minutes = 0
        if minutes <= 0:
            self._pet_auto_switch_timer.stop()
            return
        self._pet_auto_switch_timer.start(max(1, minutes) * 60 * 1000)

    def _on_pet_auto_switch(self):
        """定时到点：随机切换到另一个宠物模型（复用桌宠的随机切换）。"""
        self.pet.randomize_pet()

    # ------------------------------------------------------------------
    # 语音：代理到 VoiceController（避免 app.py 重复实现）
    # ------------------------------------------------------------------

    def _toggle_voice_orb(self):
        """切换语音球：已开启则关闭，否则打开。"""
        if self.voice.active:
            self.voice.stop()
        else:
            self.voice.open()

    def _on_voice_text_confirmed(self, text, screenshot=''):
        """VoiceController 识别到最终文字后，统一送入 mini-claw。"""
        submitted = self._send_external_command(text, 'voice', 'voice_orb', screenshot=screenshot)
        if submitted:
            self.quick_chat_source = 'voice_chat'
            self.pet.update_voice_popup('thinking', '等待回复')
        if not submitted:
            # 提交失败：重置等待状态，稍后重试录音
            self.voice.waiting_reply = False
            if self.voice.active:
                QTimer.singleShot(800, self.voice.start_recording)

    def _stop_all_tts(self):
        """停止所有 TTS 播放（VoiceController 暂停时调用）。"""
        stop_tts()

    def _pause_wake_word_listener(self):
        """暂停唤醒词监听，供中键语音输入独占麦克风。"""
        self.voice._pause_wake_word()

    def _resume_wake_word_listener(self):
        """中键录音结束后恢复唤醒词监听。"""
        self.voice._resume_wake_word()

    # ==== 启动/退出音效 ====
    def _event_tts_path(self, event_name):
        """返回启动/退出等事件音效文件路径，按音色名称区分。"""
        voice_name = config.tts_config.get('voice_name') or config.DEFAULT_TTS_CONFIG['voice_name']
        safe_name = ''.join(ch if ch.isalnum() or ch in ('-', '_') else '_' for ch in voice_name)
        return config.DATA_DIR / f'tts_{event_name}' / f'{safe_name}.wav'

    def _play_event_tts(self, event_name):
        """播放事件音效（如启动音、退出音），TTS 未启用或文件不存在时返回 False。"""
        if not config.tts_config.get('enabled'):
            return False
        path = self._event_tts_path(event_name)
        if not path.is_file():
            return False
        stop_tts()
        self.quick_stream_tts.reset()
        self.external_stream_tts.reset()
        self.event_tts_worker = TtsPreviewWorker(path, parent=self)
        self.event_tts_worker.result_ready.connect(lambda success, text: self._on_event_tts_done(event_name, success, text))
        self.event_tts_worker.start()
        return True

    def _on_event_tts_done(self, event_name, success, text):
        """事件音效播放完成回调；退出音效结束后触发真正的退出流程。"""
        if not success:
            print('Event TTS failed:', text)
        self.event_tts_worker = None
        if event_name == 'exit' and self.is_quitting:
            self._show_exit_card()
            QTimer.singleShot(300 if success else GOODBYE_CARD_QUIT_DELAY_MS, self.pet.quit_now)

    # ==== 问候卡片 ====
    def _show_startup_greeting(self):
        """应用启动后显示问候语，先播音效再显示卡片。"""
        if self._play_event_tts('startup'):
            QTimer.singleShot(EVENT_CARD_AFTER_TTS_START_DELAY_MS, self._show_startup_greeting_card)
            return
        self._show_startup_greeting_card()

    def _show_startup_greeting_card(self):
        """显示启动问候卡片，只显示一次。"""
        if self.startup_greeting_shown:
            return
        self.startup_greeting_shown = True
        x, y = self.pet.reply_card_anchor()
        name = config.pet_display_name()
        self.note.setup_reply_card_text('好久不见，想我了吗？', x, y, 6000, title=name)

    def _show_exit_card(self):
        """显示退出告别卡片，只显示一次。"""
        if self.exit_card_shown:
            return
        self.exit_card_shown = True
        x, y = self.pet.reply_card_anchor()
        self.note.setup_reply_card_text('我会想你的，再见~', x, y, 3000, title=config.pet_display_name())

    # ==== 聊天窗口 ====
    def _show_chat_window(self):
        """打开或刷新聊天窗口，传入 mini-claw 下发的历史投影。"""
        backend = self._agent_backend()
        self.chat_history = self._history_for_backend(backend)
        self.pet.show_chat(history=self.chat_history)

    # ==== 退出流程 ====
    def _on_quit_requested(self):
        """用户点退出：停止语音，播退出音效，显示告别卡片。"""
        if self.is_quitting:
            return
        self.is_quitting = True
        if self.pet.quick_menu is not None:
            self.pet.quick_menu.close()
        if self.voice.active:
            self.voice.stop()
        if self._play_event_tts('exit'):
            QTimer.singleShot(EVENT_CARD_AFTER_TTS_START_DELAY_MS, self._show_exit_card)
        else:
            self._show_exit_card()
            QTimer.singleShot(GOODBYE_CARD_QUIT_DELAY_MS, self.pet.quit_now)

    # ==== 消息内容工具方法 ====
    def _content_text_for_preview(self, content):
        """从结构化内容中提取纯文本，用于消息预览和日志。"""
        if isinstance(content, str):
            return content
        parts = []
        for block in content or []:
            if block.get('type') == 'text':
                parts.append(block.get('text', ''))
            elif block.get('type') == 'code':
                parts.append(block.get('text', ''))
        return '\n'.join(part for part in parts if part).strip()

    def _content_preview(self, content):
        """生成内容的可读预览字符串，图片用占位符表示。"""
        if isinstance(content, str):
            return content
        text = self._content_text_for_preview(content)
        image_count = sum(1 for block in content or [] if block.get('type') == 'image')
        return (text + '\n' if text else '') + ('[图片] × %d' % image_count if image_count else '')

    def _attachment_from_data_url(self, data_url, name='image.png', source='input'):
        """把 base64 data URL 转成附件字典，格式不合法时返回 None。"""
        data_url = str(data_url or '').strip()
        if not data_url.startswith('data:') or ';base64,' not in data_url:
            return None
        header, data = data_url.split(',', 1)
        mime_type = header[5:].split(';', 1)[0] or 'application/octet-stream'
        if not data:
            return None
        return {
            'type': 'image',
            'name': name,
            'mime_type': mime_type,
            'encoding': 'base64',
            'data': data,
            'source': source,
        }

    def _attachment_from_image_file(self, file_path, source='drop'):
        """把本地图片文件路径转成附件字典，非图片文件返回 None。"""
        path = Path(str(file_path or ''))
        if not path.is_file():
            return None
        mime_type = mimetypes.guess_type(str(path))[0] or ''
        if not mime_type.startswith('image/'):
            return None
        return {
            'type': 'image',
            'name': path.name,
            'mime_type': mime_type,
            'encoding': 'base64',
            'data': base64.b64encode(path.read_bytes()).decode('ascii'),
            'source': source,
        }

    def _content_attachments(self, content, screenshot=''):
        """从消息内容和截图中提取所有附件列表。"""
        attachments = []
        if screenshot:
            item = self._attachment_from_data_url(screenshot, name='screenshot.jpg', source='screenshot')
            if item:
                attachments.append(item)
        if isinstance(content, list):
            for index, block in enumerate(content):
                if block.get('type') != 'image':
                    continue
                src = block.get('src') or block.get('path') or block.get('data_url') or ''
                item = self._attachment_from_data_url(src, name=block.get('name') or 'image_%d.png' % (index + 1), source='message')
                if item is None:
                    item = self._attachment_from_image_file(src, source='message')
                if item:
                    attachments.append(item)
        return attachments

    def _drop_attachments(self, payload):
        """从拖拽投喂 payload 中提取附件列表。"""
        attachments = []
        for index, item in enumerate(payload.get('items') or []):
            if item.get('kind') not in ('image', 'file'):
                continue
            attachment = self._attachment_from_data_url(item.get('data_url'), name=item.get('name') or 'drop_%d.png' % (index + 1), source='drop')
            if attachment is None:
                attachment = self._attachment_from_image_file(item.get('path'), source='drop')
            if attachment:
                attachments.append(attachment)
        return attachments

    def _drop_payload_without_inline_image_data(self, payload):
        """移除 payload 中的内联图片 base64 数据，只保留路径引用（节省日志体积）。"""
        data = dict(payload or {})
        items = []
        for item in data.get('items') or []:
            clean = dict(item)
            clean.pop('data_url', None)
            items.append(clean)
        data['items'] = items
        return data

    def _user_input_payload(self, content, mode='text', surface='pet_popup', screenshot='', attachments=None):
        """构造用户输入 payload（用于本地 JSONL 协议）。"""
        text = self._content_text_for_preview(content)
        preview = self._content_preview(content)
        payload = {
            'text': text or preview,
            'preview': preview,
            'mode': mode,
            'surface': surface,
        }
        merged = list(attachments or [])
        merged.extend(self._content_attachments(content, screenshot=screenshot))
        if merged:
            payload['attachments'] = merged
        return payload

    # ==== mini-claw 发送入口 ====
    def _send_external_command(self, content, mode='text', surface='pet_popup', screenshot='',
                              turn_id='', surface_id='', session_id=''):
        """把所有桌宠输入交给 mini-claw Agent 内核。"""
        backend = 'minipet'
        turn = self._resolve_turn(backend, turn_id, surface_id)
        if turn is None:
            turn = self._begin_turn(backend, session_id, surface, surface_id)
        turn_id = turn.turn_id
        surface_id = turn.surface_id
        if mode in ('text', 'voice'):
            self._begin_reply_card_turn()
            self._reset_external_stream_tts()
            self._show_reply_card('正在思考...', status='streaming', timeout_ms=60000)

        sent = self.router.send(
            content,
            mode=mode,
            surface=surface,
            screenshot=screenshot,
            turn_id=turn_id,
            surface_id=surface_id,
            session_id=session_id,
        )
        if not sent:
            self._finish_turn(turn, False)
        return sent

    # ==== 回复卡片管理 ====
    def _reply_display_timeout(self, reply):
        """按回复字数计算卡片停留时间：每字 324ms，限制在 9~45 秒。"""
        return max(9000, min(45000, len(reply or '') * 324))

    def _reply_card_timeout(self, timeout_ms):
        """返回快速回复卡片的停留时间；引用追问复用卡片时保持永久显示。"""
        return 0 if self._reuse_reply_card_pending or getattr(self, '_reply_card_permanent', False) else timeout_ms

    def _show_reply_card(self, content, status='streaming', timeout_ms=60000, progress=None, result_usage=None):
        """显示或更新快速回复卡片，先尝试更新已有卡片，否则新建。"""
        timeout_ms = self._reply_card_timeout(timeout_ms)
        event = {
            'surface_id': 'local-quick-reply',
            'content': content,
            'status': status,
            'timeout_ms': timeout_ms,
        }
        if progress is not None:
            event['progress'] = progress
        event['result_usage'] = result_usage
        x, y = self.pet.reply_card_anchor()
        if self.quick_reply_card_id and self.note.update_reply_card(self.quick_reply_card_id, event, timeout=timeout_ms):
            self._reuse_reply_card_pending = False
            return
        self.quick_reply_card_id = self.note.setup_reply_card(event, x, y, play_sound=False)
        self._reuse_reply_card_pending = False

    def _begin_reply_card_turn(self):
        """开始新一轮回复卡片；引用追问时保留原卡片并重置其正文。"""
        if not self._reuse_reply_card_pending:
            self.quick_reply_card_id = None
            self._reply_card_permanent = False
        self._quick_stream_text = ''
        self._quick_reply_usage = None

    def _close_reply_card(self):
        """关闭当前快速回复卡片并清除 ID。"""
        if self.quick_reply_card_id:
            self.note.close_reply_card(self.quick_reply_card_id)
            self.quick_reply_card_id = None

    def _show_thinking_orb(self):
        """标记快速输入的思考状态，不控制独立语音球。"""
        if self.voice.active:
            return
        self._thinking_orb_active = True

    def _hide_thinking_orb(self):
        """清除快速输入的思考状态，不关闭独立语音球。"""
        self._thinking_orb_active = False

    def _show_backend_error(self, text):
        """显示 mini-claw 连接失败提示，供 BackendRouter 复用。"""
        self._close_reply_card()
        self._hide_thinking_orb()
        x, y = self.pet.reply_card_anchor()
        self.note.setup_reply_card_text(
            text or 'mini-claw 尚未连接，请先启动服务。',
            x, y, 4500, title=config.pet_display_name(),
        )

    # ==== 快速输入处理 ====
    def _on_quick_chat_prompt(self, text):
        """桌宠快速输入提交到 mini-claw。"""
        self._show_thinking_orb()
        self._send_external_command(text, 'text', 'pet_popup')
        # mini-claw 会用 surface 卡片回复，不使用快速输入弹窗自己的思考浮层。
        # submitted 信号返回后 PetInputPopup 才会 start_thinking，所以延后一拍关闭。
        QTimer.singleShot(0, self._close_input_popup)

    def _close_input_popup(self):
        """关闭快速输入弹窗（下一个事件循环再执行，避免竞态）。"""
        if self.pet.input_popup is not None:
            self.pet.input_popup.close()
            self.pet.input_popup = None

    def _on_drop_intent(self, drop_payload, intent):
        """处理拖拽投喂：统一送入 mini-claw。"""
        payload = dict(drop_payload)
        payload['intent'] = intent
        payload['surface'] = 'desktop_pet'
        payload['context'] = {'surface': 'desktop_pet'}
        x, y = self.pet.reply_card_anchor()
        intent_labels = {
            'summarize': '总结',
            'create_task': '生成待办',
            'draft_reply': '起草回复',
            'send_to_lark': '发到飞书',
            'ask': '询问处理方式',
        }
        prompt = self._drop_prompt(payload, intent_labels.get(intent, intent))
        sent = self.router.send(
            prompt,
            mode='drop',
            surface='desktop_pet',
            attachments=self._drop_attachments(payload),
            session_id=self._backend_session_id('minipet'),
            extra={
                'intent': intent,
                'drop': self._drop_payload_without_inline_image_data(payload),
            },
        )
        if sent:
            self.note.setup_reply_card_text('收到，我交给 mini-claw 处理：' + intent_labels.get(intent, intent), x, y, 3500, title=config.pet_display_name())
        else:
            self.note.setup_reply_card_text('mini-claw 还没连接，请先启动服务。', x, y, 4500, title=config.pet_display_name())

    def _drop_prompt(self, payload, intent_label):
        """把拖拽内容整理成发送给 mini-claw 的用户提示。"""
        lines = ['用户投喂了内容，希望你处理：%s。' % intent_label]
        preview = payload.get('preview') or ''
        if preview:
            lines.append('预览：' + str(preview))
        items = payload.get('items') or []
        if items:
            lines.append('投喂项：')
            for item in items:
                lines.append('- ' + json.dumps(item, ensure_ascii=False))
        return '\n'.join(lines)

    # ==== 旧版快速请求兼容入口 ====
    def _submit_quick_chat(self, text, source='quick_chat', screenshot=''):
        """兼容旧模块调用，但实际仍只走 mini-claw。"""
        mode = 'voice' if source == 'voice_chat' else 'text'
        surface = 'voice_orb' if source == 'voice_chat' else 'pet_popup'
        return self._send_external_command(text, mode, surface, screenshot=screenshot)

    def _build_quick_chat_messages(self, backend=None, screenshot=''):
        """旧版本地模型上下文接口；mini-claw 自己维护上下文。"""
        return []

    def _on_quick_chat_delta(self, text):
        """兼容旧回调：更新 mini-claw 回复卡片和 TTS 队列。"""
        if not text or self.quick_chat_worker is None:
            return
        turn = getattr(self.quick_chat_worker, '_minipet_turn', None)
        if turn is None:
            return
        update = self._accept_turn_text(turn, text, mode='delta', tts_eligible=True)
        if not update.changed:
            return
        self._quick_stream_text = update.text
        self.quick_stream_tts.queue_text(turn.surface_id, update.text, terminal=False)
        self._queue_turn_update(turn, update)

    def _on_quick_chat_reply(self, success, text):
        """Handle a quick chat response."""
        # 先清 worker 引用，防止后续递归调用时重入
        worker = self.quick_chat_worker
        self.quick_chat_worker = None
        turn = getattr(worker, '_minipet_turn', None)
        if self.quick_chat_source == 'quick_chat' and self.pet.input_popup is not None:
            self.pet.input_popup.close()
            self.pet.input_popup = None
        if success:
            reply = (text or (turn.text if turn else self._quick_stream_text)).strip() or '嗯。'
            self._quick_stream_text = reply
            if turn:
                update = self._accept_turn_text(
                    turn, reply, mode='full', terminal=True,
                    result=True, tts_eligible=True,
                )
                self.quick_stream_tts.queue_text(turn.surface_id, update.text, terminal=True)
                self.stream_display_delay.enqueue(
                    self._turn_lane(turn),
                    lambda: self._show_quick_chat_result(turn, update.text),
                )
            self._finish_quick_voice_if_tts_idle()
        else:
            self._reset_quick_stream_tts()
            if turn:
                self._finish_turn(turn, False, text)
            self._show_reply_card('我现在说不出来：' + text, status='failed', timeout_ms=6000)
            if self.quick_chat_source == 'voice_chat' and self.voice.active:
                self.voice.finish_turn(delay_ms=800)

    def _show_quick_chat_result(self, turn, reply):
        """完成一轮快速聊天：提交 turn 并展示最终卡片。"""
        self._finish_turn(turn, True, reply)
        self._show_reply_card(
            reply, status='done',
            timeout_ms=self._reply_display_timeout(reply),
        )

    # ==== TTS 回调 ====
    def _on_quick_stream_tts_started(self, stream_id, text):
        """本地 TTS 开始播放：更新卡片静音按钮状态，语音聊天时切换球为说话状态。"""
        if self.quick_reply_card_id:
            self.note.set_reply_card_tts_active(self.quick_reply_card_id, True)
        if self.quick_chat_source == 'voice_chat' and self.voice.active:
            self.voice._pause_wake_word()
            self.pet.update_voice_popup('speaking', '')

    def _finish_quick_voice_if_tts_idle(self):
        """本地 TTS 空闲回调：隐藏静音按钮，语音聊天时完成当前轮次。"""
        log.info('TTS 空闲回调: worker active=%s', self.quick_stream_tts.is_active())
        if self.quick_stream_tts.is_active():
            return
        if self.quick_reply_card_id:
            self.note.set_reply_card_tts_active(self.quick_reply_card_id, False)
        self._hide_thinking_orb()
        if self.quick_chat_source == 'voice_chat' and self.voice.active:
            self.voice.finish_turn(delay_ms=500)

    def _on_external_stream_tts_started(self, stream_id, text):
        """内核回复 TTS 开始播放：更新卡片静音按钮状态，语音聊天时切换球状态。"""
        if self.quick_reply_card_id:
            self.note.set_reply_card_tts_active(self.quick_reply_card_id, True)
        if self.quick_chat_source == 'voice_chat' and self.voice.active:
            self.voice._pause_wake_word()
            self.pet.update_voice_popup('speaking', '')

    def _finish_external_voice_if_tts_idle(self):
        """内核回复 TTS 空闲回调：隐藏静音按钮，语音聊天时完成当前轮次。"""
        if self.external_stream_tts.is_active():
            return
        if self.quick_reply_card_id:
            self.note.set_reply_card_tts_active(self.quick_reply_card_id, False)
        if self.quick_chat_source == 'voice_chat' and self.voice.active:
            self.voice.finish_turn(delay_ms=500)

    def _reset_quick_stream_tts(self):
        """重置本地快速输入 TTS 队列和流式显示延迟。"""
        self.stream_display_delay.reset('minipet')
        self._quick_stream_text = ''
        self.quick_stream_tts.reset()

    def _on_event_connection_changed(self, connected):
        """记录 mini-claw 连接状态；只在已建立过连接后提示断线，避免启动时刷屏。"""
        if self._agent_backend() != 'minipet':
            return
        previous = self._minipet_connected
        self._minipet_connected = bool(connected)
        if not connected:
            self._minipet_ready = False
        if previous and not connected:
            self.note.setup_toast('mini-claw 连接断开', '正在自动重连，新的消息会在连接恢复后继续发送。')

    def _on_minipet_ready_changed(self, ready, server_name):
        """握手完成后记录后端状态；具体提示由 session.ready 卡片统一展示。"""
        if self._agent_backend() != 'minipet' or not ready:
            if not ready:
                self._minipet_ready = False
            return
        self._minipet_ready = True
        self.events.request_history(self._backend_session_id('minipet'))

    def _request_kernel_history(self):
        """从唯一历史源刷新桌面展示；不在 Python 侧拼接或持久化消息。"""
        if self.events and self._minipet_ready:
            self.events.request_history(self._backend_session_id('minipet'))

    # ==== mini-claw 事件处理 ====
    def _on_event(self, event):
        """处理 mini-claw 推送的 JSONL 事件，按类型路由到具体处理函数。"""
        event = normalize_inbound_event(event)
        # 统一解包：payload 优先用 event[payload]，兜底用整个 event
        event_type = event.get('type', '')
        payload = event.get('payload') if isinstance(event.get('payload'), dict) else event
        x, y = self.pet.reply_card_anchor()
        if event_type == SESSION_READY:
            server = payload.get('server') if isinstance(payload.get('server'), dict) else {}
            self.note.setup_reply_card_text('内核已就绪：' + str(server.get('name') or payload.get('name') or 'mini-claw'), x, y, 3000, title=config.pet_display_name())
        elif event_type == SURFACE_SHOW:
            self._handle_surface_show(payload)
        elif event_type == SURFACE_UPDATE:
            self._handle_surface_update(payload)
        elif event_type == SURFACE_CLOSE:
            self._handle_surface_close(payload)
        elif event_type == HISTORY_RESULT:
            self._handle_history_result(payload)
        else:
            self.note.setup_toast(payload.get('title', '外部事件'), payload.get('summary') or payload.get('content') or '')

    def _handle_history_result(self, payload):
        """把 Node 内核的历史投影替换到当前窗口，保留同一个 list 引用。"""
        if payload.get('session_id') != self._backend_session_id('minipet'):
            return
        messages = []
        for item in payload.get('messages') or []:
            if not isinstance(item, dict) or item.get('role') not in ('user', 'assistant'):
                continue
            content = item.get('content')
            if not isinstance(content, str) or not content.strip():
                continue
            messages.append({'role': item['role'], 'content': content})
        self.chat_history[:] = messages
        self.chat_histories['minipet'] = self.chat_history
        if self.pet.chat_window is not None and self.pet.chat_window.isVisible():
            self.pet.chat_window.history = self.chat_history
            self.pet.chat_window.reload_history()

    def _handle_surface_show(self, payload):
        """处理 SURFACE_SHOW 事件：mini-claw 回复进入 TTS 与卡片。"""
        card_event = normalize_display_event(SURFACE_SHOW, payload)
        if self._agent_backend() == 'minipet':
            self._queue_external_reply_tts(card_event, surface_text(card_event))
        self._queue_surface_display(card_event, is_update=False)

    def _handle_surface_update(self, payload):
        """处理 SURFACE_UPDATE 事件：更新已有卡片内容。"""
        if not payload.get('surface_id'):
            return
        card_event = normalize_display_event(SURFACE_UPDATE, payload)
        if self._agent_backend() == 'minipet':
            self._queue_external_reply_tts(card_event, surface_text(card_event))
        self._queue_surface_display(card_event, is_update=True)
        if is_terminal_surface_status(card_event):
            self._request_kernel_history()

    def _queue_surface_display(self, card_event, is_update):
        """将 surface 显示操作入队（防止流式输出时闪烁）。"""
        surface_id = card_event.get('surface_id') or '__external_reply__'
        self.stream_display_delay.enqueue(
            'surface:' + surface_id,
            lambda: self._show_surface_event(card_event, is_update),
        )

    def _show_surface_event(self, card_event, is_update):
        """实际显示 surface 卡片，更新已有卡片或新建卡片。"""
        self._finish_surface_turn_if_terminal(card_event)
        text = surface_text(card_event)
        if is_silent_surface_text(text) and not card_event.get('elements') and not card_event.get('actions') and not card_event.get('controls'):
            return
        # surface_id 用于关联后续 UPDATE/CLOSE 事件；更新已有卡片时不能关闭当前快速回复卡片。
        surface_id = card_event.get('surface_id')
        timeout = surface_timeout(card_event)
        card_id = self._surface_cards.get(surface_id) if is_update else None
        if card_id and self.note.update_reply_card(card_id, card_event, timeout=timeout):
            self._handle_external_voice_surface(card_event)
            return
        if not is_update:
            self._close_reply_card()
        x, y = self.pet.reply_card_anchor()
        card_id = self.note.setup_reply_card(card_event, x, y, play_sound=False)
        if surface_id:
            self._surface_cards[surface_id] = card_id
        self._handle_external_voice_surface(card_event)

    def _finish_surface_turn_if_terminal(self, card_event):
        """终态 surface 结束对应桌宠输入轮次，并刷新只读历史投影。"""
        turn = self._resolve_turn(
            'minipet', card_event.get('turn_id'), card_event.get('surface_id'),
        )
        if turn is not None and is_terminal_surface_status(card_event):
            self._finish_turn(turn, not self._surface_failed(card_event), surface_text(card_event))
            self._request_kernel_history()

    @staticmethod
    def _surface_failed(card_event):
        """终态 surface 是否代表失败；失败文本不应写入 assistant 历史。"""
        status = str(card_event.get('status') or card_event.get('state') or '').strip().lower().replace('_', '-')
        return status in ('failed', 'failure', 'error')

    def _queue_external_reply_tts(self, card_event, text):
        """将外置回复文本入队到 external_stream_tts，不触发 TTS 时直接跳过。"""
        if not text:
            return
        if is_silent_surface_text(text) or not surface_tts_eligible(card_event):
            return
        # 空正文终态帧只表示 surface 生命周期结束，不再回读旧正文补触发 TTS。
        surface_id = card_event.get('surface_id') or '__external_reply__'
        terminal = is_terminal_surface_status(card_event)
        self.external_stream_tts.queue_text(surface_id, text, terminal=terminal)

    def _reset_external_stream_tts(self):
        """重置外置 TTS 队列和流式显示延迟（取消后续输出）。"""
        self.stream_display_delay.reset()
        self.external_stream_tts.reset()

    def _handle_external_voice_surface(self, card_event):
        """mini-claw 有卡片回复时关闭本地语音等待状态。"""
        if not self.voice.active or not self.voice.waiting_reply or self.quick_chat_source != 'voice_chat':
            return
        if self._daily_input_ctrl._recording:
            return
        text = surface_text(card_event)
        if text:
            # mini-claw 已经用卡片在回复了，语音等待浮层不应该继续盖在卡片上。
            # V1 surface 协议不允许后端控制宠物动作；有正文后就清掉本地等待动作。
            self.pet.close_voice_popup()
            self.pet.play_action('idle')
        if is_terminal_surface_status(card_event):
            self._finish_external_voice_if_tts_idle()

    def _handle_surface_close(self, payload):
        """处理 SURFACE_CLOSE 事件：关闭卡片并清理 TTS 队列。"""
        surface_id = payload.get('surface_id')
        if not surface_id:
            return
        self.stream_display_delay.reset('surface:' + surface_id)
        card_id = self._surface_cards.pop(surface_id, None)
        if card_id:
            self.note.close_reply_card(card_id)
        self.external_stream_tts.reset(surface_id)

    # ==== 回复卡片事件回调 ====
    def _on_reply_card_action(self, event, action):
        """回复卡片按钮点击回调：处理复制、打开聊天、外置动作等。"""
        action_id = action.get('id') or action.get('type')
        text = action.get('text') or event.get('suggestion') or event.get('summary') or event.get('content') or ''
        x, y = self.pet.reply_card_anchor()
        if action.get('action_type') == 'approval':
            if self.events and self._agent_backend() == 'minipet':
                self.events.execute_approval(event, action)
            return
        if action_id == 'ignore':
            return
        if action_id == 'copy':
            QGuiApplication.clipboard().setText(text)
            self.note.setup_reply_card_text('已复制到剪贴板', x, y, 3000)
            return
        if action_id == 'open_chat':
            self._show_chat_window()
            return
        if action_id == 'later':
            self.note.setup_reply_card_text(f'稍后提醒功能会在 {config.APP_DISPLAY_NAME} 本地提醒模块中接入', x, y, 4000)
            return
        if self.events:
            self.events.execute_action(event, action)

    def _on_reply_card_interrupted(self, _card_id):
        """回复卡片中断按钮回调：取消 mini-claw 轮次，重置 TTS。"""
        self.router.cancel_workers()
        if self.events and self._agent_backend() == 'minipet':
            surface_id = next((sid for sid, cid in self._surface_cards.items() if cid == _card_id), '')
            turn = self._resolve_turn('minipet', surface_id=surface_id)
            self.events.cancel_turn(
                session_id=turn.session_id if turn else self._backend_session_id('minipet'),
                turn_id=turn.turn_id if turn else '',
                surface_id=surface_id or (turn.surface_id if turn else ''),
            )
        self.quick_stream_tts.reset()
        self.external_stream_tts.reset()
        if self.voice.active and self.voice.waiting_reply:
            self.voice.finish_turn(delay_ms=300)

    def _on_reply_card_mute_tts(self, card_id):
        """回复卡片静音回调：停止 TTS，但保留文字回复和卡片。"""
        # 取消尚未执行的流式显示回调，避免静音后旧队列继续触发状态更新。
        self.stream_display_delay.reset('minipet')
        self.quick_stream_tts.reset()
        self.external_stream_tts.reset()
        if card_id:
            self.note.set_reply_card_tts_active(card_id, False)
        self._hide_thinking_orb()
        if self.quick_chat_source == 'voice_chat' and self.voice.active and self.voice.waiting_reply:
            self.voice.finish_turn(delay_ms=300)

    def _on_reply_card_quote(self, card_id, message, quoted_text='', user_text=''):
        """Handle a quoted reply within an existing card."""
        has_images = isinstance(message, list) and any(b.get('type') == 'image' for b in message if isinstance(b, dict))
        # 存储时带结构化 quote block，聊天窗口 reload 时可渲染飞书风格引用
        if quoted_text and user_text and not has_images:
            display_content = [{'type': 'text', 'text': user_text,
                                 'quote': quoted_text[:80] + ('...' if len(quoted_text) > 80 else '')}]
        elif has_images:
            # 图片模式：保留 image blocks，text block 加 quote
            display_content = []
            for block in message:
                if isinstance(block, dict) and block.get('type') == 'text' and quoted_text:
                    display_content.append({'type': 'text', 'text': user_text or block.get('text', ''),
                                            'quote': quoted_text[:80] + ('...' if len(quoted_text) > 80 else '')})
                else:
                    display_content.append(block)
        else:
            display_content = message
        # 引用发送后复用原卡片：正文保持上一轮回复不动，仅显示思考动画，永久保留。
        # 新回复的第一个增量到达时才整体替换正文并打字输出，避免清空成空白卡片干等。
        self.quick_reply_card_id = card_id
        self._reuse_reply_card_pending = True
        self._reply_card_permanent = True
        self._quick_stream_text = ''
        self._quick_reply_usage = None
        self.note.update_reply_card(
            card_id,
            {'status': 'thinking', 'timeout_ms': 0},
            timeout=0,
        )
        self._send_external_command(
            message,
            'text',
            'reply_card_quote',
            session_id=self._backend_session_id('minipet'),
        )

    # ==== 应用关闭 ====
    def request_quit(self):
        """请求应用退出，确保信号退出与界面退出使用同一状态。"""
        if self.is_quitting:
            return
        self.is_quitting = True
        self.pet.quit_now()

    def shutdown(self):
        """应用退出时清理所有后台线程和资源。"""
        if self._shutdown_started:
            return
        self._shutdown_started = True
        self.is_quitting = True
        stop_tts()
        self.settings.shutdown()
        if self.pet.chat_window is not None:
            self.pet.chat_window.shutdown()
        self.pet.close_voice_popup()
        self.quick_stream_tts.reset()
        self.external_stream_tts.reset()
        self.router.shutdown()
        # VoiceController 负责 ASR worker 的清理
        self.voice.stop()
        # 释放剩余的 worker
        for worker_name in ('quick_chat_worker', 'event_tts_worker'):
            worker = getattr(self, worker_name, None)
            if worker is not None and worker.isRunning():
                worker.requestInterruption()
                worker.quit()
                worker.wait(1000)
            setattr(self, worker_name, None)
        self.pet._stop_animation()
        self._daily_input_ctrl.shutdown()
        if self.events:
            self.events.stop()
            self.events = None


def main():
    # 应用入口统一初始化日志：全部模块经 log_util 输出，格式一致、可过滤
    setup_logging()
    app = MiniPetApp(sys.argv)
    signal.signal(signal.SIGINT, lambda signum, frame: app.request_quit())
    signal.signal(signal.SIGTERM, lambda signum, frame: app.request_quit())
    timer = QTimer()
    timer.start(250)
    timer.timeout.connect(lambda: None)
    code = 0
    try:
        code = app.exec()
    finally:
        app.shutdown()
    sys.exit(code)
