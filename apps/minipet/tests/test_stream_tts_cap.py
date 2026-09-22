# coding:utf-8
"""流式 TTS 朗读字数上限测试：max_chars 截断整轮合成文本。

不启动真实 worker 线程：切分逻辑是纯队列操作，mock 掉
_PipelineTtsWorker 后只断言入队的切块内容，避免测试期间
真实连接 TTS 服务或占用音频设备。
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

import config
from clients.stream_tts import StreamTtsQueue


class StreamTtsCapTest(unittest.TestCase):

    def _queue_and_send(self, max_chars, text):
        with patch.object(config, 'tts_config', {'enabled': True, 'api_key': 'k', 'max_chars': max_chars}), \
             patch('clients.stream_tts._PipelineTtsWorker') as worker_cls:
            worker = worker_cls.return_value
            queue = StreamTtsQueue()
            queue.queue_text('s1', text, terminal=True)
        calls = worker.enqueue.call_args_list
        return [(c.args[1], c.kwargs.get('terminal', False)) for c in calls]

    def test_max_chars_caps_whole_stream(self):
        """max_chars 截断的是整轮合成文本，而不是单个分块"""
        chunks = self._queue_and_send(10, '字' * 60)
        total = sum(len(text) for text, _ in chunks)
        self.assertEqual(10, total)
        self.assertTrue(chunks[-1][1])  # 最后一块带 terminal 标记，正常收尾

    def test_below_cap_synthesizes_all(self):
        """未达上限时全部合成"""
        chunks = self._queue_and_send(200, '字' * 60)
        total = sum(len(text) for text, _ in chunks)
        self.assertEqual(60, total)
        self.assertTrue(chunks[-1][1])


if __name__ == '__main__':
    unittest.main()
