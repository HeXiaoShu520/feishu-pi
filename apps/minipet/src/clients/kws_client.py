# coding:utf-8
"""sherpa-onnx 神经网络关键词唤醒（KWS）监听线程。

使用 Zipformer 流式模型做音素级关键词检索，比手写模板匹配更抗
语速/音量/距离变化，误唤醒率显著更低。唤醒词在 keywords 文件中以
拼音 token 配置（如 `x iǎo y uè x iǎo y uè @小月小月 :1.5`）。

对外接口：detected / status_changed / error_received 信号，
pause / resume / stop 控制方法，由 VoiceController 直接使用。
"""

import time
from pathlib import Path

from PySide6.QtCore import QThread, Signal

try:
    import sounddevice as sd
except Exception:
    sd = None

try:
    import numpy as np
except Exception:
    np = None

try:
    import sherpa_onnx
except Exception:
    sherpa_onnx = None

from log_util import get_logger

log = get_logger('voice.kws')

# 监听采集参数：16kHz 单声道 int16，与工程其他 ASR 链路一致
SAMPLE_RATE = 16000
CHUNK_MS = 100
# 同一次命中后的冷却时间，防止拖长音被连续触发
COOLDOWN_MS = 1800
# 唤醒词关键词权重：越高越容易命中（误触也随之上升）；可在设置页调节
KEYWORD_WEIGHT = 2.0


def words_to_keyword_line(word, weight=KEYWORD_WEIGHT):
    """把中文唤醒词转成 sherpa keywords 文件的一行。

    输出格式为"声母 韵母 @原词 :权重"，例如
    小月小月 → `x iǎo üè x iǎo üè @小月小月 :1.5`。
    声韵母用 pypinyin 带调拆分，token 覆盖 KWS 模型的 tokens.txt。
    """
    from pypinyin import Style, lazy_pinyin
    word = str(word or '').strip()
    if not word:
        raise KwsError('唤醒词不能为空')
    # strict=False：w/y（问=wen、月=yue）按声母拆分，与模型官方关键词
    # 文件的拆分方式一致；默认严格模式会拆出词表中不存在的碎片 token
    initials = lazy_pinyin(word, style=Style.INITIALS, strict=False, errors='ignore')
    finals = lazy_pinyin(word, style=Style.FINALS_TONE, v_to_u=True, strict=False, errors='ignore')
    tokens = [token for pair in zip(initials, finals) for token in pair if token]
    return ' '.join(tokens) + ' @%s :%s' % (word, weight)


def write_keywords_file(path, words, weight=KEYWORD_WEIGHT):
    """把逗号/空格分隔的多个唤醒词写入 keywords 文件。"""
    text = str(words or '')
    raw_words = [item for chunk in text.replace('，', ',').split(',') for item in chunk.split()]
    raw_words = [item.strip() for item in raw_words if item.strip()]
    if not raw_words:
        raise KwsError('请至少填写一个唤醒词')
    lines = [words_to_keyword_line(item, weight=weight) for item in raw_words]
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return raw_words


class KwsError(Exception):
    """KWS 模型或音频设备错误。"""


def find_model_dir(root_dir):
    """在 models/ 下自动定位 KWS 模型目录；未找到返回 None。

    判定标准：目录同时包含 tokens.txt 和 keywords.txt（模型完整性标志）。
    """
    root = Path(root_dir)
    if not root.is_dir():
        return None
    for candidate in sorted(root.iterdir()):
        if (candidate / 'tokens.txt').is_file() and (candidate / 'keywords.txt').is_file():
            return candidate
    return None


def resolve_keywords_path(path_text, root_dir):
    """把配置中的 keywords 相对路径解析为绝对路径；空值回落默认位置。"""
    text = str(path_text or '').strip() or 'res/wake/keywords.txt'
    path = Path(text)
    return path if path.is_absolute() else Path(root_dir) / path


class SherpaKwsWorker(QThread):
    """sherpa-onnx KWS 后台监听线程，供 VoiceController 直接使用。"""

    detected = Signal(str)
    status_changed = Signal(str)
    error_received = Signal(str)

    def __init__(self, wake_config=None, root_dir='.', parent=None):
        super().__init__(parent)
        self.wake_config = dict(wake_config or {})
        self.root_dir = str(root_dir)
        self.running = True
        self.paused = False
        self.stream = None

    def run(self):
        """初始化 KWS 引擎并进入监听主循环。"""
        try:
            self._run_loop()
        except Exception as error:
            # 退出/停止期间的设备关闭竞态（如 PortAudio 已随应用关闭）
            # 属正常现象，静默结束；仍在监听状态时的异常才上报
            if self.running:
                log.warning('KWS 监听错误: %s', error)
                self.error_received.emit(str(error))
        finally:
            self.stream = None

    def _build_keyword_spotter(self):
        """按配置创建 KeywordSpotter；模型或 keywords 缺失时抛出 KwsError。"""
        if sherpa_onnx is None:
            raise KwsError('缺少 sherpa-onnx，请执行：pip install sherpa-onnx')
        model_dir = self.wake_config.get('kws_model_dir') or ''
        model_dir = Path(model_dir) if model_dir else find_model_dir(Path(self.root_dir) / 'models')
        if model_dir is None or not Path(model_dir).is_dir():
            raise KwsError('未找到 KWS 模型，请先运行 tools/download_kws_model.py')
        keywords_path = resolve_keywords_path(
            self.wake_config.get('kws_keywords_path') or 'res/wake/keywords.txt',
            self.root_dir,
        )
        if not keywords_path.is_file():
            raise KwsError('未找到唤醒词配置文件：%s' % keywords_path)
        return sherpa_onnx.KeywordSpotter(
            tokens=str(Path(model_dir) / 'tokens.txt'),
            encoder=str(next(Path(model_dir).glob('encoder*epoch-99*.onnx'))),
            decoder=str(next(Path(model_dir).glob('decoder*epoch-99*.onnx'))),
            joiner=str(next(Path(model_dir).glob('joiner*epoch-99*.onnx'))),
            keywords_file=str(keywords_path),
            num_threads=1,
            sample_rate=SAMPLE_RATE,
            feature_dim=80,
        )

    @staticmethod
    def _to_float_wave(raw):
        """把 int16 PCM 字节转成 KWS 要求的归一化 float 序列。"""
        if np is None:
            raise KwsError('缺少 numpy，请执行：pip install numpy')
        return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

    def _run_loop(self):
        """持续读麦克风喂给流式 KWS，命中即发 detected 信号并冷却。"""
        build_started = time.monotonic()
        spotter = self._build_keyword_spotter()
        stream = spotter.create_stream()
        log.info('KWS 引擎就绪（模型加载 %.1f 秒）', time.monotonic() - build_started)
        self.status_changed.emit('等待唤醒词')
        blocksize = SAMPLE_RATE * CHUNK_MS // 1000
        last_hit_ms = 0.0
        with sd.RawInputStream(samplerate=SAMPLE_RATE, channels=1, dtype='int16', blocksize=blocksize) as capture:
            self.stream = capture
            log.info('KWS 麦克风已打开，开始监听唤醒词')
            while self.running:
                if self.paused:
                    # 暂停时丢弃积压音频并复位流式状态，避免恢复后误触发
                    capture.read(blocksize)
                    spotter.reset_stream(stream)
                    time.sleep(0.08)
                    continue
                audio, overflowed = capture.read(blocksize)
                if overflowed:
                    self.status_changed.emit('唤醒监听音频溢出')
                stream.accept_waveform(SAMPLE_RATE, self._to_float_wave(bytes(audio)))
                while spotter.is_ready(stream):
                    spotter.decode_stream(stream)
                result = spotter.get_result(stream)
                if not result:
                    continue
                now = time.monotonic() * 1000
                if now - last_hit_ms < COOLDOWN_MS:
                    continue
                last_hit_ms = now
                log.info('唤醒命中: %s', result)
                spotter.reset_stream(stream)
                self.detected.emit(result)
                self.status_changed.emit('已唤醒')
                self.pause()

    def pause(self):
        """暂停读取和匹配，但保留线程。"""
        self.paused = True

    def resume(self):
        """恢复匹配。"""
        self.paused = False
        self.status_changed.emit('等待唤醒词')

    def stop(self):
        """请求线程退出；音频流由监听线程退出时自行关闭。

        不能在这里跨线程 close 流：此刻监听线程可能正阻塞在 read() 上，
        并发关闭属于 PortAudio 原生层竞态，会直接崩溃整个进程。
        """
        self.running = False
        self.paused = False
