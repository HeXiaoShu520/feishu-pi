# coding:utf-8
"""唤醒词命中率诊断工具。

先完全退出桌宠（避免两个进程争抢麦克风），在项目根目录运行：
    .venv/Scripts/python.exe tools/diagnose_wake.py

运行后 20 秒内对着麦克风反复清晰地说唤醒词（每次间隔 1 秒以上）。
结束后会自动用不同权重/阈值组合回放同一段录音，输出哪组设置能命中，
以及麦克风音量是否正常。
"""

import os
import sys
import time

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(APP_DIR)
sys.path.insert(0, os.path.join(APP_DIR, 'src'))

import numpy as np
import sounddevice as sd

import config
from clients.kws_client import find_model_dir, write_keywords_file

import sherpa_onnx

RECORD_SECONDS = 10
BLOCKSIZE = 1280  # 80ms @16kHz


def record(seconds):
    blocks = []
    peaks = []
    print('录音 %d 秒，请反复清晰地说唤醒词（正常说话峰值应达到几千）…' % seconds)
    with sd.RawInputStream(samplerate=16000, channels=1, dtype='int16', blocksize=BLOCKSIZE) as cap:
        start = time.monotonic()
        while time.monotonic() - start < seconds:
            audio, overflowed = cap.read(BLOCKSIZE)
            arr = np.frombuffer(bytes(audio), dtype=np.int16)
            blocks.append(arr.copy())
            peaks.append(int(np.abs(arr).max()))
    per_sec = [max(peaks[i * 12:(i + 1) * 12], default=0) for i in range(0, len(peaks), 12)]
    print('每秒音量峰值:', per_sec)
    return np.concatenate([b for b in blocks])


def sweep(samples, model_dir, words, weight, threshold):
    kw = 'kw_diag.txt'
    write_keywords_file(kw, words, weight=weight)
    kws = sherpa_onnx.KeywordSpotter(
        tokens=os.path.join(model_dir, 'tokens.txt'),
        encoder=os.path.join(model_dir, 'encoder-epoch-99-avg-1-chunk-16-left-64.onnx'),
        decoder=os.path.join(model_dir, 'decoder-epoch-99-avg-1-chunk-16-left-64.onnx'),
        joiner=os.path.join(model_dir, 'joiner-epoch-99-avg-1-chunk-16-left-64.onnx'),
        keywords_file=kw,
        num_threads=4, feature_dim=80,
        keywords_threshold=threshold,
    )
    stream = kws.create_stream()
    hits = []
    i = 0
    n = len(samples)
    while i < n:
        end = min(i + BLOCKSIZE, n)
        stream.accept_waveform(16000, samples[i:end])
        i = end
        while kws.is_ready(stream):
            kws.decode_stream(stream)
        r = kws.get_result(stream)
        if r:
            hits.append(r)
    return len(hits)


def main():
    words = str(config.wake_word_config.get('words') or '小呆小呆')
    model_dir = find_model_dir(os.path.join(APP_DIR, 'models'))
    samples = record(RECORD_SECONDS)
    peak = int(np.abs(samples).max())
    print('整段录音峰值音量: %d' % peak)
    if peak < 800:
        print('!! 峰值太低：几乎没有采到你的声音。请检查 Windows 麦克风'
              '输入音量/设备选择，或离麦克风近一些再测。')
        return

    print('\n开始扫描 权重 x 阈值 组合（共 6 组，每组回放同一份录音）：')
    results = []
    for weight in (2.5, 3.5, 5.0):
        for threshold in (0.25, 0.15):
            hits = sweep(samples, model_dir, words, weight, threshold)
            results.append((weight, threshold, hits))
            print('  权重 %.1f / 阈值 %.2f → 命中 %d 次' % (weight, threshold, hits))

    best = max(results, key=lambda r: r[2])
    print('\n结论：最佳组合 权重=%.1f 阈值=%.2f（命中 %d 次）' % (best[0], best[1], best[2]))
    print('若所有组合都是 0 次：说明模型对这个词本身不敏感，建议换一个'
          ' 4 音节以上、发音独特的唤醒词（如"小呆小呆"），再跑一次本工具。')


if __name__ == '__main__':
    main()
