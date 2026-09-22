# coding:utf-8
"""
火山豆包 TTS 客户端和 PCM 播放器。

提供三层能力：
- PcmStreamPlayer：把服务端返回的 PCM 流写入本地声卡。
- tts_to_pcm()/play_tts()：通过 WebSocket 合成语音并播放/缓存。
- TtsWorker/TtsCacheWorker/TtsPreviewWorker：供 Qt UI 后台线程调用。
"""

import asyncio
import audioop
import inspect
import json
import queue
import re
import struct
import threading
import time
import uuid
import wave
from pathlib import Path

from PySide6.QtCore import QThread, Signal

try:
    import sounddevice as sd
except Exception:
    sd = None

import config

try:
    import websockets
except Exception:
    websockets = None

TTS_WS_URL = 'wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream'
TTS_RESOURCE_ID = 'seed-tts-2.0'
# 豆包 TTS 固定输出 24kHz 单声道 16bit PCM
SAMPLE_RATE = 24000
CHANNELS = 1
SAMPLE_WIDTH = 2
# BUFFER_SIZE 对应声卡每次回调读取的帧数；过小会增加回调频率，过大会增加延迟
BUFFER_SIZE = 4096
# 全局唯一当前播放器，用于 stop_tts() 打断正在播放的音频
_active_player = None
_active_lock = threading.Lock()


class TtsPlaybackError(Exception):
    """TTS 播放链路异常。"""


class PcmStreamPlayer:
    """基于 sounddevice 的 PCM 流式播放器。

    采用生产者-消费者模型：write() 向队列追加数据块，
    sounddevice 的音频回调线程从队列消费并写入声卡。
    closed 事件用于通知回调线程不再等待新数据，安全退出。
    """

    def __init__(self, sample_rate=SAMPLE_RATE):
        if sd is None:
            raise TtsPlaybackError('缺少 sounddevice，请执行：pip install sounddevice')
        self.queue = queue.Queue()
        self.closed = threading.Event()
        self.paused = threading.Event()
        self.stream = sd.RawOutputStream(
            samplerate=sample_rate,
            channels=CHANNELS,
            dtype='int16',
            blocksize=BUFFER_SIZE,
            callback=self._callback,
        )
        self.stream.start()

    def _callback(self, outdata, frames, time_info, status):
        need = frames * CHANNELS * SAMPLE_WIDTH
        if self.paused.is_set():
            outdata[:] = b'\x00' * need
            return
        chunks = bytearray()
        while len(chunks) < need:
            if self.closed.is_set() and self.queue.empty():
                break
            try:
                chunks.extend(self.queue.get_nowait())
            except queue.Empty:
                break
        # 数据不足时补零静音，避免声卡欠载（underrun）产生爆音
        if len(chunks) < need:
            chunks.extend(b'\x00' * (need - len(chunks)))
        output = bytes(chunks[:need])
        # 音量调节：用 audioop.mul 直接对 PCM 做整数乘法，避免引入浮点开销
        volume = max(0.0, min(1.0, float(config.app_config.get('volume', 0.4))))
        if volume != 1.0:
            output = audioop.mul(output, SAMPLE_WIDTH, volume)
        outdata[:] = output
        rest = chunks[need:]
        if rest:
            # 将本次多余数据回塞到队列头，下次回调继续使用
            self.queue.queue.appendleft(bytes(rest))

    def write(self, chunk):
        if chunk:
            self.queue.put(bytes(chunk))

    def wait_done(self):
        # 轮询队列清空，再等 250ms 让声卡缓冲区完全输出，避免截断末尾音频
        while self.paused.is_set() or not self.queue.empty():
            time.sleep(0.05)
        time.sleep(0.25)

    def pause(self):
        self.paused.set()

    def resume(self):
        self.paused.clear()

    def close(self):
        self.closed.set()
        try:
            self.stream.stop()
        finally:
            self.stream.close()


def split_sentences(text, first_target_chars=30, target_chars=80):
    """将长文本切分成适合 TTS 合成的短句列表。

    first_target_chars=30：第一句故意更短，让用户更快听到第一帧音频，
    后续句子按 target_chars=80 切分以减少 WebSocket 请求次数。
    切分优先在标点处断行，找不到标点时强制截断。
    """
    text = (text or '').strip()
    if not text:
        return []
    parts = re.split(r'(?<=[\n。！？!?；;，,：:、])', text)
    chunks = []
    current = ''
    for part in (p.strip() for p in parts if p.strip()):
        limit = first_target_chars if not chunks else target_chars
        while len(part) > limit:
            if current:
                chunks.append(current)
                current = ''
                limit = target_chars
            cut = max(part.rfind(mark, 0, limit + 1) for mark in '，,、：:；;。！？!?')
            if cut <= 0:
                cut = limit
            else:
                cut += 1
            chunks.append(part[:cut].strip())
            part = part[cut:].strip()
            limit = target_chars
        if not part:
            continue
        limit = first_target_chars if not chunks else target_chars
        if current and len(current) + len(part) > limit:
            chunks.append(current)
            current = part
        else:
            current = current + part if current else part
    if current:
        chunks.append(current)
    return chunks


def _build_ws_payload(text, cfg):
    # disable_markdown_filter=True 防止服务端过滤 Markdown 符号，由调用方自行处理格式
    additions = {
        'disable_markdown_filter': True,
        'disable_emoji_filter': bool(config.DEFAULT_TTS_CONFIG['disable_emoji_filter']),
        'max_length_to_filter_parenthesis': int(config.DEFAULT_TTS_CONFIG['max_length_to_filter_parenthesis']),
    }
    return {
        'req_params': {
            'text': text,
            'speaker': cfg.get('voice_name') or config.DEFAULT_TTS_CONFIG['voice_name'],
            'audio_params': {'format': 'pcm', 'sample_rate': SAMPLE_RATE},
            'additions': json.dumps(additions, ensure_ascii=False),
        },
    }


def _build_ws_packet(payload):
    body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return bytes([0x11, 0x10, 0x10, 0x00]) + struct.pack('>I', len(body)) + body


def _read_u32(data, offset, label):
    if offset + 4 > len(data):
        raise TtsPlaybackError('TTS WS response missing %s' % label)
    return struct.unpack('>I', data[offset:offset + 4])[0]


def _parse_ws_packet(data):
    """解析 TTS WebSocket 响应帧，返回 (kind, payload, session_id)。

    kind:
      'audio' — payload 为 PCM 字节数据
      'json'  — payload 为解析后的 dict（含空 dict 表示流结束）
    豆包 TTS 协议 message_type=0xB 为音频帧，0xF 为错误帧。
    flags=0x4 时帧头携带 session_id 字符串（部分响应）。
    """
    if len(data) < 4:
        raise TtsPlaybackError('TTS WS response too short')
    message_type = data[1] >> 4
    flags = data[1] & 0x0F
    serialization = data[2] >> 4
    offset = (data[0] & 0x0F) * 4
    if offset > len(data):
        raise TtsPlaybackError('TTS WS invalid header size')
    if message_type == 0xF:
        code = _read_u32(data, offset, 'error code')
        offset += 4
        size = _read_u32(data, offset, 'error payload size')
        offset += 4
        payload = data[offset:offset + size]
        raise TtsPlaybackError('TTS WS %s: %s' % (code, payload.decode('utf-8', errors='replace')))
    if flags in (0x1, 0x3):
        if offset + 4 > len(data):
            return 'json', {}, ''
        offset += 4
    session_id = ''
    if flags == 0x4:
        if offset + 8 > len(data):
            return 'json', {}, ''
        offset += 4
        session_size = _read_u32(data, offset, 'session id size')
        offset += 4
        session_id = data[offset:offset + session_size].decode('utf-8', errors='replace')
        offset += session_size
    if offset + 4 > len(data):
        return 'json', {}, session_id
    size = _read_u32(data, offset, 'payload size')
    offset += 4
    payload = data[offset:offset + size]
    if message_type == 0xB:
        return 'audio', payload, session_id
    if serialization == 0x1 and payload:
        return 'json', json.loads(payload.decode('utf-8')), session_id
    return 'json', {}, session_id


async def _request_audio_chunks_async(text, cfg, cancel_event=None):
    """向 TTS WebSocket 服务发送文本并异步产出 PCM 音频块。

    cancel_event：外部可随时 set() 来中断请求，每次 recv 超时（0.25s）后检查一次，
    保证取消响应延迟不超过一个轮询周期。
    空 dict payload 表示服务端流结束信号，此时正常退出生成器。
    """
    if websockets is None:
        raise TtsPlaybackError('缺少 websockets，请执行：pip install websockets')
    api_key = cfg.get('api_key') or ''
    if not api_key:
        raise TtsPlaybackError('请先填写 TTS API Key')
    if cancel_event is not None and cancel_event.is_set():
        return
    headers = {
        'X-Api-Key': api_key,
        'X-Api-Resource-Id': TTS_RESOURCE_ID,
        'X-Api-Request-Id': str(uuid.uuid4()),
    }
    header_arg = 'additional_headers' if 'additional_headers' in inspect.signature(websockets.connect).parameters else 'extra_headers'
    ws_kwargs = {header_arg: headers, 'ping_interval': 20, 'ping_timeout': 20}
    # 显式直连：websockets 默认走系统代理，实测代理转发该域名会引入约 6 秒握手延迟
    if 'proxy' in inspect.signature(websockets.connect).parameters:
        ws_kwargs['proxy'] = None
    async with websockets.connect(TTS_WS_URL, **ws_kwargs) as ws:
        await ws.send(_build_ws_packet(_build_ws_payload(text, cfg)))
        while True:
            if cancel_event is not None and cancel_event.is_set():
                return
            try:
                message = await asyncio.wait_for(ws.recv(), timeout=0.25 if cancel_event is not None else 60)
            except asyncio.TimeoutError:
                if cancel_event is not None:
                    continue
                raise TtsPlaybackError('TTS WS response timeout')
            if not isinstance(message, bytes):
                continue
            kind, payload, _session_id = _parse_ws_packet(message)
            if kind == 'audio' and payload:
                yield payload
            elif kind == 'json':
                if isinstance(payload, dict) and payload.get('error'):
                    raise TtsPlaybackError(payload.get('error'))
                if payload == {}:
                    return


def _request_audio_chunks(text, cfg, cancel_event=None):
    async def collect():
        chunks = []
        async for chunk in _request_audio_chunks_async(text, cfg, cancel_event=cancel_event):
            chunks.append(chunk)
        return chunks
    return asyncio.run(collect())


def request_audio_chunks(text, cfg=None, cancel_event=None):
    cfg = dict(cfg or config.tts_config)
    max_chars = max(1, int(cfg.get('max_chars') or config.DEFAULT_TTS_CONFIG['max_chars']))
    text = (text or '').replace('\\n', '\n').replace('\\r', '\r').replace('\\t', '\t').strip()[:max_chars]
    # 火山 TTS 对纯标点、表情或空白会返回 No readable text，直接跳过这类片段。
    if not text or not re.search(r'[\w㐀-鿿]', text, re.UNICODE):
        return []
    return _request_audio_chunks(text, cfg, cancel_event=cancel_event)


def set_active_player(player):
    global _active_player
    with _active_lock:
        _active_player = player


def clear_active_player(player):
    global _active_player
    with _active_lock:
        if _active_player is player:
            _active_player = None


def _speak(text, cfg):
    # 按句切分后逐句请求音频，这样第一句合成完即可开始播放，不必等全文完成
    max_chars = max(1, int(cfg.get('max_chars') or config.DEFAULT_TTS_CONFIG['max_chars']))
    text = (text or '').strip()[:max_chars]
    if not text:
        return
    segments = split_sentences(text)
    if not segments:
        return
    player = PcmStreamPlayer(SAMPLE_RATE)
    global _active_player
    with _active_lock:
        _active_player = player
    try:
        has_audio = False
        for segment in segments:
            for payload in _request_audio_chunks(segment, cfg):
                has_audio = True
                player.write(payload)
        if not has_audio:
            raise TtsPlaybackError('TTS: no audio received')
        player.wait_done()
    finally:
        with _active_lock:
            if _active_player is player:
                _active_player = None
        player.close()


def _write_wav(file_path, pcm_chunks):
    file_path = Path(file_path)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(file_path), 'wb') as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(SAMPLE_RATE)
        for chunk in pcm_chunks:
            wf.writeframes(chunk)


def _synthesize_to_file(text, cfg, file_path):
    file_path = Path(file_path)
    chunks = []
    for sentence in split_sentences(text):
        for payload in _request_audio_chunks(sentence, cfg):
            chunks.append(payload)
    if not chunks:
        raise TtsPlaybackError('TTS: no audio received')
    _write_wav(file_path, chunks)


def synthesize_to_file(text, cfg, file_path):
    _synthesize_to_file(text, dict(cfg), file_path)


def play_pcm_file(file_path):
    file_path = Path(file_path)
    if not file_path.is_file():
        raise TtsPlaybackError('音频文件不存在：%s' % file_path)
    player = PcmStreamPlayer(SAMPLE_RATE)
    global _active_player
    with _active_lock:
        _active_player = player
    try:
        if file_path.suffix.lower() == '.wav':
            with wave.open(str(file_path), 'rb') as wf:
                while True:
                    chunk = wf.readframes(BUFFER_SIZE)
                    if not chunk:
                        break
                    player.write(chunk)
        else:
            with file_path.open('rb') as f:
                while True:
                    chunk = f.read(BUFFER_SIZE)
                    if not chunk:
                        break
                    player.write(chunk)
        player.wait_done()
    finally:
        with _active_lock:
            if _active_player is player:
                _active_player = None
        player.close()


def speak_text(text, cfg=None):
    _speak(text, dict(cfg or config.tts_config))


def stop_tts():
    global _active_player
    with _active_lock:
        player = _active_player
        _active_player = None
    if player is not None:
        player.close()


class TtsPreviewWorker(QThread):
    """预览已缓存的本地 WAV 文件，不重新请求 TTS 服务。

    用于语音设置页面的"试听"按钮：先停止当前播放，再播放本地缓存文件。
    result_ready(True, path) 或 result_ready(False, error_msg)。
    """
    result_ready = Signal(bool, str)

    def __init__(self, file_path, parent=None):
        super().__init__(parent)
        self.file_path = Path(file_path)

    def run(self):
        try:
            stop_tts()
            if not self.file_path.is_file() or self.file_path.stat().st_size <= 0:
                raise TtsPlaybackError('缺少本地预览音频：%s' % self.file_path.name)
            play_pcm_file(self.file_path)
            self.result_ready.emit(True, str(self.file_path))
        except Exception as e:
            self.result_ready.emit(False, str(e))


class TtsWorker(QThread):
    """在后台线程执行 TTS 合成并播放，不阻塞 Qt 主线程。

    result_ready(True, '') 表示播放完成；result_ready(False, error) 表示失败。
    """
    result_ready = Signal(bool, str)

    def __init__(self, text, cfg=None, parent=None):
        super().__init__(parent)
        self.text = text
        self.cfg = dict(cfg) if cfg is not None else dict(config.tts_config)

    def run(self):
        try:
            speak_text(self.text, self.cfg)
            self.result_ready.emit(True, '')
        except Exception as e:
            self.result_ready.emit(False, str(e))


class TtsCacheWorker(QThread):
    """合成语音、写入本地缓存文件并立即播放，可选同时导出到指定路径。

    执行顺序：stop_tts() → synthesize_to_file() → (可选 shutil.copy2) → play_pcm_file()
    若合成失败且产出了空文件，会自动删除该文件，避免下次误用空缓存。
    """
    result_ready = Signal(bool, str)

    def __init__(self, text, cfg, file_path, export_path=None, parent=None):
        super().__init__(parent)
        self.text = text
        self.cfg = dict(cfg)
        self.file_path = Path(file_path)
        self.export_path = Path(export_path) if export_path else None

    def run(self):
        try:
            stop_tts()
            synthesize_to_file(self.text, self.cfg, self.file_path)
            if self.export_path:
                import shutil
                self.export_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(self.file_path, self.export_path)
            play_pcm_file(self.file_path)
            self.result_ready.emit(True, str(self.export_path or self.file_path))
        except Exception as e:
            if self.file_path.exists() and self.file_path.stat().st_size == 0:
                self.file_path.unlink()
            self.result_ready.emit(False, str(e))
