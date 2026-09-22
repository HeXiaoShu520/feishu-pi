# coding:utf-8
"""麦克风录音测试：录 10 秒存为 test_mic.wav，自己播放验证。

运行后请立即开始说话（数数或随便说什么），结束后：
- 播放 test_mic.wav：能听到自己的声音 → 麦克风正常
- 全程静音 → 默认输入设备不对或被独占，换 Windows 默认输入设备
"""

import os
import sys
import time
import wave

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(APP_DIR)

import numpy as np
import sounddevice as sd

SECONDS = 10
print('== 系统输入设备列表 ==')
default_in = sd.default.device[0]
for i, d in enumerate(sd.query_devices()):
    if d['max_input_channels'] > 0:
        mark = '   <-- 当前默认' if i == default_in else ''
        print('[%d] %s%s' % (i, d['name'], mark))

input('\n按回车开始录 10 秒，请对着说话…')

blocks = []
with sd.RawInputStream(samplerate=16000, channels=1, dtype='int16', blocksize=1280) as cap:
    start = time.monotonic()
    while time.monotonic() - start < SECONDS:
        audio, overflowed = cap.read(1280)
        blocks.append(bytes(audio))
        arr = np.frombuffer(bytes(audio), dtype=np.int16)
        print('  音量: %5d' % int(np.abs(arr).max()), end='\r')

samples = np.frombuffer(b''.join(blocks), dtype=np.int16)
with wave.open('test_mic.wav', 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(16000)
    w.writeframes(samples.tobytes())
print('\n已保存 test_mic.wav（项目根目录），双击播放听一下录没录上。')
