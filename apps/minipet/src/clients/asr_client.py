# coding:utf-8
"""
火山豆包流式 ASR 客户端。

这个模块把麦克风 PCM 音频按火山 SAUC 协议打包，经 WebSocket 发送到 ASR
服务，并把中间识别结果、最终识别结果和错误通过 Qt 信号返回给 UI。
"""

import asyncio
import gzip
import inspect
import json
import queue
import struct
import threading
import time
import uuid


# 末帧后等待服务端回传最终结果的最长时间，超时只用于避免异常连接永久挂起。
FINAL_RESPONSE_TIMEOUT_SECONDS = 2.0

from PySide6.QtCore import QThread, Signal

try:
    import sounddevice as sd
except Exception:
    sd = None

try:
    import websockets
except Exception:
    websockets = None

import config
from log_util import get_logger

log = get_logger('voice.asr')

ASR_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
ASR_RESOURCE_ID = 'volc.seedasr.sauc.duration'
# 麦克风采集参数：16kHz 单声道 16bit PCM，符合豆包 ASR 协议要求
INPUT_SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2          # 字节/采样（int16）
# 每帧 200ms：低于 100ms 会加重网络开销，超过 500ms 会引入明显延迟
CHUNK_MS = 200
CHUNK_BYTES = int(INPUT_SAMPLE_RATE * CHUNK_MS / 1000) * SAMPLE_WIDTH

# ---- 火山 SAUC 二进制协议常量 ----
# 消息类型（header byte[1] 高 4 位）
MSG_FULL_CLIENT_REQUEST = 0x1   # 会话开启帧，含 JSON 配置
MSG_AUDIO_ONLY_REQUEST = 0x2    # 纯音频帧
MSG_FULL_SERVER_RESPONSE = 0x9  # 服务端完整响应
MSG_ERROR = 0xF                 # 服务端错误帧
# 序列化方式（header byte[2] 高 4 位）
SER_RAW = 0x0
SER_JSON = 0x1
# 压缩方式（header byte[2] 低 4 位）
COMP_GZIP = 0x1
COMP_NONE = 0x0
# 序列标志（header byte[1] 低 4 位）——决定帧是否携带序列号以及是否为末帧
FLAG_NONE = 0x0
FLAG_POS_SEQUENCE = 0x1         # 携带正序列号（非末帧）
FLAG_LAST_NO_SEQUENCE = 0x2     # 末帧，无序列号
FLAG_LAST_NEG_SEQUENCE = 0x3    # 末帧，携带负序列号


class AsrError(Exception):
    """ASR 采集或协议调用异常。"""


def _header(message_type, flags, serialization, compression):
    # 固定4字节头：版本号 0x11，类型+标志，序列化+压缩，保留位
    return bytes([0x11, (message_type << 4) | flags, (serialization << 4) | compression, 0x00])


def _pack_u32(value):
    return struct.pack('>I', int(value))


def _pack_i32(value):
    return struct.pack('>i', int(value))


def _build_packet(message_type, flags, serialization, compression, payload=b'', sequence=None):
    # sequence 只在需要携带序列号的帧（FLAG_POS_SEQUENCE / FLAG_LAST_NEG_SEQUENCE）时传入
    if serialization == SER_JSON and not isinstance(payload, bytes):
        payload = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if compression == COMP_GZIP:
        payload = gzip.compress(payload)
    parts = [_header(message_type, flags, serialization, compression)]
    if sequence is not None:
        parts.append(_pack_i32(sequence))
    parts.append(_pack_u32(len(payload)))
    parts.append(payload)
    return b''.join(parts)


def build_start_request():
    """构造会话开启帧（MSG_FULL_CLIENT_REQUEST）。

    该帧必须是连接后发送的第一帧，携带音频格式、模型和转写参数。
    使用 gzip 压缩以减少初始握手数据量。
    """
    payload = {
        'user': {'uid': config.APP_ID},
        'audio': {
            'format': 'pcm',
            'codec': 'raw',
            'rate': INPUT_SAMPLE_RATE,
            'bits': 16,
            'channel': CHANNELS,
            'language': 'zh-CN',
        },
        'request': {
            'model_name': 'bigmodel',
            'enable_itn': True,
            'enable_punc': True,
            'enable_ddc': False,
            'enable_nonstream': True,
            'show_utterances': True,
            'result_type': 'full',
            'end_window_size': 800,
            'force_to_speech_time': 800,
        },
    }
    return _build_packet(MSG_FULL_CLIENT_REQUEST, FLAG_NONE, SER_JSON, COMP_GZIP, payload)


def build_audio_packet(audio, final=False, sequence=None):
    # final=True 时设置末帧标志，服务端据此触发最终识别结果
    # sequence=None 用 FLAG_LAST_NO_SEQUENCE；否则用 FLAG_LAST_NEG_SEQUENCE 携带负序列号
    flags = FLAG_LAST_NO_SEQUENCE if final and sequence is None else FLAG_LAST_NEG_SEQUENCE if final else FLAG_NONE
    return _build_packet(MSG_AUDIO_ONLY_REQUEST, flags, SER_RAW, COMP_GZIP, audio or b'', sequence=sequence)


def parse_response(data):
    """解析服务端返回的二进制帧，返回结构化字典。

    协议布局：
      byte[0]  版本/头部扩展长度（低4位 * 4 = offset 到 payload）
      byte[1]  高4位=消息类型，低4位=标志
      byte[2]  高4位=序列化，低4位=压缩
      byte[3]  保留
      [offset..] 序列号（可选 4 字节 i32）+ payload 长度（4 字节 u32）+ payload

    返回字典包含 _sequence（序列号或 None）和 _last（是否末帧）标志。
    """
    if len(data) < 8:
        raise AsrError('ASR response too short')
    message_type = data[1] >> 4
    flags = data[1] & 0x0F
    serialization = data[2] >> 4
    compression = data[2] & 0x0F
    offset = (data[0] & 0x0F) * 4
    sequence = None
    if message_type == MSG_ERROR:
        code = struct.unpack('>I', data[offset:offset + 4])[0]
        offset += 4
        size = struct.unpack('>I', data[offset:offset + 4])[0]
        offset += 4
        return {'error': data[offset:offset + size].decode('utf-8', errors='replace'), 'code': code}
    if flags in (FLAG_POS_SEQUENCE, FLAG_LAST_NEG_SEQUENCE):
        sequence = struct.unpack('>i', data[offset:offset + 4])[0]
        offset += 4
    size = struct.unpack('>I', data[offset:offset + 4])[0]
    offset += 4
    payload = data[offset:offset + size]
    if compression == COMP_GZIP and payload:
        payload = gzip.decompress(payload)
    if serialization == SER_JSON and payload:
        result = json.loads(payload.decode('utf-8'))
    else:
        result = {'payload': payload}
    result['_sequence'] = sequence
    result['_last'] = flags in (FLAG_LAST_NO_SEQUENCE, FLAG_LAST_NEG_SEQUENCE)
    return result


class MicrophoneStreamer:
    """麦克风实时采集器，用 sounddevice RawInputStream 驱动声卡。

    通过 on_audio 回调把每帧 PCM 字节传给调用方；
    采集在独立的 sounddevice 线程运行，不阻塞主线程。
    """
    def __init__(self, on_audio):
        if sd is None:
            raise AsrError('缺少 sounddevice，请执行：pip install sounddevice')
        self.on_audio = on_audio
        self.stream = None

    def start(self):
        if self.stream is not None:
            return
        self.stream = sd.RawInputStream(
            samplerate=INPUT_SAMPLE_RATE,
            channels=CHANNELS,
            dtype='int16',
            blocksize=CHUNK_BYTES // SAMPLE_WIDTH,
            callback=self._callback,
        )
        self.stream.start()

    def _callback(self, indata, frames, time_info, status):
        self.on_audio(bytes(indata))

    def stop(self):
        stream = self.stream
        self.stream = None
        if stream is not None:
            try:
                stream.stop()
            finally:
                stream.close()


class AsrSession:
    """单次 ASR 会话的状态机，管理麦克风、音频队列和 WebSocket 通信。

    生命周期：
      1. 外部调用 command('start') → 启动麦克风，开始采集并发送音频帧
      2. 外部调用 command('stop')  → 暂停麦克风，停止发送（但 WebSocket 保持）
      3. 外部调用 command('finish') → 发送末帧，关闭会话

    回调线程：text_cb/final_cb/status_cb/error_cb 在 asyncio 事件循环线程触发，
    调用方如需更新 Qt UI 应通过 Signal 跨线程转发。
    """
    def __init__(self, text_cb=None, final_cb=None, status_cb=None, error_cb=None):
        self.text_cb = text_cb or (lambda text: None)
        self.final_cb = final_cb or (lambda text: None)
        self.status_cb = status_cb or (lambda text: None)
        self.error_cb = error_cb or (lambda text: None)
        # 缓冲区上限 80 帧 ≈ 16 秒音频；超出时丢弃最旧帧，防止网络卡顿导致内存持续增长
        self.audio_queue = queue.Queue(maxsize=80)
        self.commands = queue.Queue()
        self.mic = None
        self.recording = False
        self.closed = False
        self.finishing = False
        # WebSocket 握手完成后置位；UI 层据此区分“连接中”与“可以识别”
        self.connected = False
        # 麦克风可能被 UI 线程提前启动（按下即录），与 asyncio 线程共用，需要锁保护
        self._mic_lock = threading.Lock()
        # sent_finals 用于去重：同一 utterance 可能被多帧响应反复上报
        self.sent_finals = set()

    def command(self, name):
        if self.closed or (self.finishing and name != 'finish'):
            return
        self.commands.put(name)

    def _headers(self):
        # ASR 和 TTS 共用同一个 API Key（tts_config），避免用户配置两份凭证
        api_key = config.tts_config.get('api_key') or ''
        if not api_key:
            raise AsrError('请先在语音设置中填写 TTS API Key')
        request_id = str(uuid.uuid4())
        return {
            'X-Api-Key': api_key,
            'X-Api-Resource-Id': ASR_RESOURCE_ID,
            'X-Api-Request-Id': request_id,
            'X-Api-Connect-Id': request_id,
            'X-Api-Sequence': '-1',
        }

    async def run(self):
        """建立 WebSocket 连接并启动接收/指令两个并发任务。

        两任务任一退出（正常或异常）都会触发 finally 清理：
        关闭麦克风、设置 closed 标志、取消另一个任务。
        """
        if websockets is None:
            raise AsrError('缺少 websockets，请执行：pip install websockets')
        header_arg = 'additional_headers' if 'additional_headers' in inspect.signature(websockets.connect).parameters else 'extra_headers'
        ws_kwargs = {header_arg: self._headers(), 'ping_interval': 20, 'ping_timeout': 20}
        # 显式直连：websockets 默认走系统代理，实测代理转发该域名会引入约 6 秒握手延迟
        if 'proxy' in inspect.signature(websockets.connect).parameters:
            ws_kwargs['proxy'] = None
        connect_started = time.monotonic()
        async with websockets.connect(ASR_URL, **ws_kwargs) as ws:
            # 握手耗时日志：用于区分"网络慢"与"死连接等待"两类问题
            log.info('WebSocket 握手耗时 %.0f ms', (time.monotonic() - connect_started) * 1000)
            self.connected = True
            self.status_cb('ASR已连接')
            await ws.send(build_start_request())
            receiver = asyncio.create_task(self._receive_loop(ws))
            commander = asyncio.create_task(self._command_loop(ws))
            try:
                done, _ = await asyncio.wait([receiver, commander], return_when=asyncio.FIRST_COMPLETED)
                # 末帧已经送出时，命令循环会先结束；此时必须继续接收服务端 final，
                # 不能把“本地没有更多命令”等同于“服务端已完成识别”。
                if commander in done and self.finishing and not receiver.done():
                    try:
                        await asyncio.wait_for(receiver, FINAL_RESPONSE_TIMEOUT_SECONDS)
                    except asyncio.TimeoutError:
                        self.status_cb('ASR最终结果接收超时')
            finally:
                self.closed = True
                self._stop_recording()
                for task in (receiver, commander):
                    if not task.done():
                        task.cancel()

    async def _receive_loop(self, ws):
        async for message in ws:
            data = parse_response(message)
            if data.get('error'):
                error = str(data.get('error'))
                if 'session has ended' in error:
                    self.closed = True
                    return
                self.error_cb(error)
                continue
            text = self._extract_text(data)
            if text:
                self.text_cb(text)
            for item_id, final_text in self._extract_final_utterances(data):
                if item_id not in self.sent_finals and final_text:
                    self.sent_finals.add(item_id)
                    self.final_cb(final_text)

    def _extract_text(self, data):
        result = data.get('result') or {}
        if isinstance(result, dict):
            return result.get('text') or ''
        return ''

    def _extract_final_utterances(self, data):
        """从响应帧中提取已确认（definite=True）的语句片段。

        服务端按 utterances 列表上报，每条 utterance 有独立时间戳；
        用 (start_time, end_time, index) 作 ID 可避免因消息重传导致重复回调。
        """
        result = data.get('result') or {}
        utterances = result.get('utterances') if isinstance(result, dict) else []
        finals = []
        for index, utterance in enumerate(utterances or []):
            if utterance.get('definite'):
                item_id = '%s:%s:%s' % (utterance.get('start_time'), utterance.get('end_time'), index)
                finals.append((item_id, utterance.get('text') or ''))
        return finals

    async def _command_loop(self, ws):
        while not self.closed:
            try:
                command = await asyncio.to_thread(self.commands.get, True, 0.05)
            except queue.Empty:
                await self._drain_audio(ws)
                continue
            if command == 'start':
                self._start_recording()
                self.status_cb('正在识别')
            elif command == 'stop':
                self._stop_recording()
                await self._drain_audio(ws)
                self.status_cb('ASR已暂停')
            elif command == 'finish':
                if self.finishing:
                    continue
                self.finishing = True
                self._stop_recording()
                await self._drain_audio(ws)
                await ws.send(build_audio_packet(b'', final=True))
                # 该 worker 已经结束录音轮次，保留接收循环等待服务端 final。
                return
            await self._drain_audio(ws)

    async def _drain_audio(self, ws):
        while True:
            try:
                audio = self.audio_queue.get_nowait()
            except queue.Empty:
                return
            await ws.send(build_audio_packet(audio))
            await asyncio.sleep(0)

    def _on_audio(self, audio):
        if not self.recording:
            return
        try:
            self.audio_queue.put_nowait(audio)
        except queue.Full:
            # 队列满时丢弃最旧帧再入队，保证实时性优先于完整性
            try:
                self.audio_queue.get_nowait()
            except queue.Empty:
                pass
            self.audio_queue.put_nowait(audio)

    def begin_capture(self):
        """按下即采集：不等 WebSocket 握手，先启动麦克风把音频缓冲到本地队列。

        连接建立后 _command_loop 的 'start' 分支和 _drain_audio 会把缓冲的
        音频按序补发到服务端，说话内容不因握手延迟而丢失。
        """
        self._start_recording()

    def _start_recording(self):
        with self._mic_lock:
            if self.recording:
                return
            self.recording = True
            mic = MicrophoneStreamer(self._on_audio)
            mic.start()
            self.mic = mic

    def _stop_recording(self):
        with self._mic_lock:
            self.recording = False
            mic = self.mic
            self.mic = None
        if mic is not None:
            mic.stop()


class AsrWorker(QThread):
    """Qt 后台线程，把 AsrSession 的 asyncio 事件循环封装进 QThread。

    UI 层只需操作 start_recording() / stop_recording() / finish()，
    结果通过 Qt Signal 安全传回主线程，无需手动处理线程同步。
    """
    status_changed = Signal(str)
    text_received = Signal(str)
    final_received = Signal(str)
    error_received = Signal(str)
    finished_signal = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.session = None
        self._pending_commands = []
        self._ready = threading.Event()

    def run(self):
        # 在 QThread 内创建 session，确保 Signal.emit 在正确线程注册
        self.session = AsrSession(
            text_cb=self.text_received.emit,
            final_cb=self.final_received.emit,
            status_cb=self.status_changed.emit,
            error_cb=self.error_received.emit,
        )
        self._ready.set()
        for command in self._pending_commands:
            self.session.command(command)
        self._pending_commands.clear()
        try:
            asyncio.run(self.session.run())
        except Exception as e:
            self.error_received.emit(str(e))
        finally:
            self.finished_signal.emit()

    def _command(self, name):
        # 线程启动阶段先缓存命令，session 创建后由 run() 转入命令队列。
        if self.session is not None:
            self.session.command(name)
        elif not self.isFinished():
            self._pending_commands.append(name)

    def is_connected(self):
        """当前会话是否已完成 WebSocket 握手（standby 预连接成功即为 True）。"""
        return bool(self.session is not None and self.session.connected)

    def start_recording(self):
        # 按下即采集：session 已存在时立刻开麦缓冲音频，握手完成后再补发
        if self.session is not None:
            self.session.begin_capture()
        self._command('start')

    def stop_recording(self):
        self._command('stop')

    def finish(self):
        self._command('finish')
