# coding:utf-8
"""输入在 mini-claw 子进程重启窗口内不能静默丢失。"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from clients.event_client import EventClient
from protocols.protocol_v1 import INPUT_ACCEPTED, SESSION_READY


class EventClientDeliveryTest(unittest.TestCase):

    def test_unacknowledged_input_replays_after_session_ready(self):
        client = EventClient()
        writes = []
        client._write_locked = lambda message: writes.append(dict(message)) or True

        self.assertTrue(client.send_input({'text': '断线期间的消息'}))
        self.assertEqual([], writes)
        self.assertEqual(1, len(client._pending_inputs))

        client._handle_line(json.dumps({
            'version': '1.0',
            'type': SESSION_READY,
            'payload': {'server': {'name': 'mini-claw'}},
        }))
        self.assertEqual(1, len(writes))
        request_id = writes[0]['request_id']

        client._handle_line(json.dumps({
            'version': '1.0',
            'type': INPUT_ACCEPTED,
            'request_id': request_id,
            'payload': {},
        }))
        self.assertEqual(0, len(client._pending_inputs))


if __name__ == '__main__':
    unittest.main()
