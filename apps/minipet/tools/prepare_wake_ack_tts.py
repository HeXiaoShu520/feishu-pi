# coding:utf-8
"""预制唤醒确认语音。

运行时唤醒确认只播放 data/tts_wake_ack 下的本地 PCM 文件，不请求 TTS。
需要新增音色或更新文案时，先运行本脚本把文件准备好。
"""

import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT_DIR / 'src'
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

import config
from clients.tts_client import synthesize_to_file
from windows.settings.voice_pages import VOICE_OPTIONS

WAKE_ACK_ITEMS = (
    ('wake_ack_1', '我在呢。'),
    ('wake_ack_2', '怎么啦？'),
    ('wake_ack_3', '在！'),
    ('wake_ack_4', '哎！'),
)


def safe_voice_name(voice_name):
    return ''.join(ch if ch.isalnum() or ch in ('-', '_') else '_' for ch in voice_name)


def main():
    config.load()
    api_key = config.tts_config.get('api_key') or ''
    if not api_key:
        raise SystemExit('缺少 TTS API Key，请先在设置 > 语音中保存 API Key。')

    base_cfg = dict(config.tts_config)
    base_cfg['enabled'] = True
    output_root = config.DATA_DIR / 'tts_wake_ack'

    for voice_name, voice_label in VOICE_OPTIONS:
        cfg = dict(base_cfg)
        cfg['voice_name'] = voice_name
        voice_dir = output_root / safe_voice_name(voice_name)
        for key, text in WAKE_ACK_ITEMS:
            output_path = voice_dir / (key + '.wav')
            if output_path.is_file() and output_path.stat().st_size > 0:
                print('skip', voice_label, key, output_path)
                continue
            print('write', voice_label, key, text, output_path)
            synthesize_to_file(text, cfg, output_path)


if __name__ == '__main__':
    main()
