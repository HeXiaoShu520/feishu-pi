# coding:utf-8

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from text_stream import TextEvent, TextStreamState


class TextStreamStateTest(unittest.TestCase):
    def test_delta_updates_are_immediately_monotonic(self):
        stream = TextStreamState()

        first = stream.accept(TextEvent('A', mode='delta', tts_eligible=True))
        second = stream.accept(TextEvent('B', mode='delta', tts_eligible=True))
        third = stream.accept(TextEvent('C', mode='delta', tts_eligible=True))

        self.assertEqual(('A', 'AB', 'ABC'), (first.text, second.text, third.text))
        self.assertEqual(('A', 'B', 'C'), (first.delta, second.delta, third.delta))
        self.assertEqual((1, 2, 3), (first.version, second.version, third.version))

    def test_full_text_ignores_duplicates_and_stale_snapshots(self):
        stream = TextStreamState()
        stream.accept_full('ABC')

        duplicate = stream.accept_full('ABC')
        stale = stream.accept_full('AB')

        self.assertFalse(duplicate.changed)
        self.assertFalse(stale.changed)
        self.assertEqual('ABC', stream.text)

    def test_progress_does_not_change_final_text(self):
        stream = TextStreamState()
        stream.accept(TextEvent('答案', mode='delta', tts_eligible=True))

        progress = stream.accept(TextEvent('正在调用工具', kind='progress'))

        self.assertFalse(progress.changed)
        self.assertFalse(progress.tts_eligible)
        self.assertEqual('答案', stream.text)

    def test_terminal_rejects_late_delta(self):
        stream = TextStreamState()
        stream.accept_delta('A')
        terminal = stream.accept_full('AB', terminal=True)
        late = stream.accept_delta('C')

        self.assertEqual('AB', terminal.text)
        self.assertFalse(late.changed)
        self.assertEqual('AB', stream.text)


if __name__ == '__main__':
    unittest.main()
