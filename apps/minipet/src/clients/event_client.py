# coding:utf-8
"""MiniPet 与 mini-claw 的本地 JSONL 子进程通道。

MiniPet 启动一个 `npm run start -- --stdio` 子进程，双方通过 stdin/stdout
交换一行一个 JSON 信封。日志走 stderr，业务事件走 stdout，因此不需要端口、
HTTP 降级或服务发现；流式 surface 事件原样逐行传递。
"""

import json
import logging
import os
import subprocess
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path

from PySide6.QtCore import QThread, Signal

from protocols.protocol_v1 import (
    SESSION_HELLO,
    SESSION_READY,
    HISTORY_GET,
    INPUT_ACCEPTED,
    USER_APPROVAL,
    USER_CANCEL,
    USER_INPUT,
    history_payload,
    hello_payload,
    normalize_inbound_event,
)


log = logging.getLogger('minipet.kernel')

MAX_PENDING_INPUTS = 20


class EventClient(QThread):
    """后台子进程客户端，向 UI 线程发出规范化事件。"""

    event_received = Signal(dict)
    connection_changed = Signal(bool)
    ready_changed = Signal(bool, str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.running = True
        self.process = None
        self.client_id = 'minipet-' + uuid.uuid4().hex
        self.ready = False
        self._connected = False
        self._write_lock = threading.Lock()
        # 仅保留尚未收到 input.accepted 的用户输入。子进程重启后会原样重投，
        # 不让快捷输入、语音转写或卡片按钮在 stdin 断开窗口内悄悄丢失。
        self._pending_inputs = OrderedDict()

    def _kernel_command(self):
        """返回当前工程内核的启动命令；不依赖 PATH 中的全局 tsx。"""
        project_root = Path(__file__).resolve().parents[4]
        npm = 'npm.cmd' if os.name == 'nt' else 'npm'
        mode = os.environ.get('MINIPET_KERNEL_MODE', 'start').strip().lower()
        script = 'dev' if mode in ('dev', 'watch') else 'start'
        return [npm, 'run', script, '--', '--stdio'], project_root

    def run(self):
        """启动内核并持续读取 stdout；内核退出时按退避策略重启。"""
        retry_delay = 1
        while self.running:
            process = None
            try:
                command, cwd = self._kernel_command()
                env = os.environ.copy()
                env['MINIPET_STDIO'] = '1'
                # npm 的生命周期提示也走 stdout；静默后 stdout 只剩协议 JSONL。
                env['npm_config_loglevel'] = 'silent'
                process = subprocess.Popen(
                    command,
                    cwd=str(cwd),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=None,
                    text=True,
                    bufsize=1,
                    universal_newlines=True,
                )
                self.process = process
                self._connected = True
                self.ready = False
                self.connection_changed.emit(True)
                self._send_direct({
                    'version': '1.0',
                    'type': SESSION_HELLO,
                    'payload': hello_payload({
                        'id': self.client_id,
                        'name': 'MiniPet',
                        'version': '1.0',
                    }),
                })
                retry_delay = 1
                for raw in process.stdout or ():
                    if not self.running:
                        break
                    self._handle_line(raw)
                if self.running:
                    time.sleep(retry_delay)
                    retry_delay = min(retry_delay * 2, 10)
            except Exception as exc:
                if self.running:
                    log.warning('mini-claw 子进程启动/读取失败：%s', exc)
                    time.sleep(retry_delay)
                    retry_delay = min(retry_delay * 2, 10)
            finally:
                self._disconnect_process(process)

    def _handle_line(self, raw):
        try:
            event = self._normalize(json.loads(raw))
        except Exception:
            # stdout 只允许协议行；偶发的启动噪音不应打断通道。
            return
        if event.get('type') == SESSION_READY:
            payload = event.get('payload') if isinstance(event.get('payload'), dict) else {}
            server = payload.get('server') if isinstance(payload.get('server'), dict) else {}
            name = str(server.get('name') or payload.get('name') or 'mini-claw')
            self.ready = True
            self.ready_changed.emit(True, name)
            self._flush_pending_inputs()
        if event.get('type') == INPUT_ACCEPTED:
            request_id = event.get('request_id')
            if isinstance(request_id, str):
                with self._write_lock:
                    self._pending_inputs.pop(request_id, None)
        self.event_received.emit(event)

    def _normalize(self, data):
        """为缺失字段的消息补默认值，再交给协议规范化。"""
        if not isinstance(data, dict):
            return normalize_inbound_event(data)
        event = dict(data)
        event.setdefault('type', 'message')
        event.setdefault('priority', 'normal')
        return normalize_inbound_event(event)

    def _send_direct(self, message):
        with self._write_lock:
            return self._write_locked(message)

    def _write_locked(self, message):
        """在持有 _write_lock 时写入当前 stdin。"""
        process = self.process
        if process is None or process.poll() is not None or process.stdin is None:
            return False
        try:
            process.stdin.write(json.dumps(message, ensure_ascii=False) + '\n')
            process.stdin.flush()
            return True
        except (BrokenPipeError, OSError, ValueError):
            return False

    def send_event(self, event_type, payload=None, request_id=None):
        """向内核写入一条 JSONL 事件。"""
        if event_type == USER_INPUT:
            return self.send_input(payload)
        message = {
            'version': '1.0',
            'type': event_type,
            'payload': payload or {},
        }
        if request_id:
            message['request_id'] = request_id
        return self._send_direct(message)

    def send_input(self, payload=None):
        """可靠提交用户输入。

        写入管道不代表内核真正读取到了消息。输入会一直留在队列中，直到同一个
        request_id 收到 input.accepted；若子进程在这之间退出，会在下一次握手后重投。
        """
        request_id = 'input-' + uuid.uuid4().hex
        message = {
            'version': '1.0',
            'type': USER_INPUT,
            'payload': payload or {},
            'request_id': request_id,
        }
        with self._write_lock:
            if len(self._pending_inputs) >= MAX_PENDING_INPUTS:
                log.warning('mini-claw 未确认输入达到上限（%d），拒绝继续排队', MAX_PENDING_INPUTS)
                return False
            self._pending_inputs[request_id] = message
            if self.ready:
                self._write_locked(message)
        # 即使当前断线也视为桌面端已接收：连接恢复后会自动投递。
        return True

    def _flush_pending_inputs(self):
        """在新内核完成握手后，重投所有尚未被确认的输入。"""
        with self._write_lock:
            for message in self._pending_inputs.values():
                if not self._write_locked(message):
                    break

    def request_history(self, session_id='minipet:global'):
        return self.send_event(HISTORY_GET, history_payload(session_id), request_id='history-' + uuid.uuid4().hex)

    def send_v1_event(self, v1_type, payload=None, request_id=None):
        return self.send_event(v1_type, payload, request_id)

    def execute_action(self, event, action):
        """把卡片按钮点击转换为 user.input。"""
        action_text = action.get('label') or action.get('text') or action.get('id') or action.get('type') or '确认'
        values = event.get('values')
        if values:
            action_text += '\n' + json.dumps(values, ensure_ascii=False)
        payload = {'text': action_text}
        for key in ('session_id', 'turn_id', 'surface_id'):
            value = event.get(key)
            if value:
                payload[key] = value
        return self.send_event(USER_INPUT, payload)

    def execute_approval(self, event, action):
        """把授权按钮作为结构化 user.approval 发送，服务端再次校验 token。"""
        payload = {}
        for key in ('approval_id', 'token', 'decision'):
            value = action.get(key)
            if value:
                payload[key] = value
        message_id = event.get('approval_message_id')
        if message_id:
            payload['message_id'] = message_id
        for key in ('session_id', 'turn_id', 'surface_id'):
            value = event.get(key)
            if value:
                payload[key] = value
        if not payload.get('approval_id') or not payload.get('token') or payload.get('decision') not in ('allow_once', 'deny'):
            return False
        return self.send_event(USER_APPROVAL, payload)

    def cancel_turn(self, session_id='', turn_id='', surface_id=''):
        payload = {}
        for key, value in (('session_id', session_id), ('turn_id', turn_id), ('surface_id', surface_id)):
            if value:
                payload[key] = value
        return self.send_event(USER_CANCEL, payload)

    def _disconnect_process(self, process):
        if process is not None and process.poll() is None and not self.running:
            try:
                process.terminate()
            except OSError:
                pass
        if process is self.process:
            self.process = None
        if self.ready:
            self.ready = False
            self.ready_changed.emit(False, '')
        if self._connected:
            self._connected = False
            self.connection_changed.emit(False)

    def stop(self):
        """停止内核子进程并等待线程退出。"""
        self.running = False
        process = self.process
        if process is not None and process.poll() is None:
            try:
                process.terminate()
            except OSError:
                pass
        self.quit()
        if not self.wait(1500) and process is not None and process.poll() is None:
            try:
                process.kill()
            except OSError:
                pass
