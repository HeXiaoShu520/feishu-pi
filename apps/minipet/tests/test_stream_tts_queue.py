# coding:utf-8

import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from clients.stream_tts import StreamTtsQueue


class StreamTtsQueueTest(unittest.TestCase):
    @patch('clients.stream_tts.config.tts_config', {'enabled': True, 'api_key': 'test'})
    def test_duplicate_full_text_and_terminal_are_not_enqueued_twice(self):
        stream = StreamTtsQueue()
        worker = Mock()
        stream.worker = worker
        stream.current_stream_id = 'reply-1'

        self.assertTrue(stream.queue_text('reply-1', '这是第一段完整回复。', terminal=True))
        self.assertFalse(stream.queue_text('reply-1', '这是第一段完整回复。', terminal=True))

        self.assertEqual(1, worker.enqueue.call_count)

    def test_pause_and_resume_delegate_without_resetting_progress(self):
        stream = StreamTtsQueue()
        worker = Mock()
        stream.worker = worker
        stream.current_stream_id = 'reply-1'
        stream.consumed['reply-1'] = 12

        self.assertTrue(stream.pause())
        self.assertTrue(stream.is_paused())
        self.assertTrue(stream.resume())
        self.assertFalse(stream.is_paused())
        self.assertEqual(12, stream.consumed['reply-1'])
        worker.pause.assert_called_once_with()
        worker.resume.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
