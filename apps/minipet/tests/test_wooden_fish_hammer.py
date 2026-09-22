# coding:utf-8

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from widgets.easter.wooden_fish import WoodenFishPopup


class WoodenFishHammerTest(unittest.TestCase):
    def hammer_angle_at(self, progress):
        popup = WoodenFishPopup.__new__(WoodenFishPopup)
        popup._hit_progress = lambda: progress
        return popup._hammer_angle()

    def test_hammer_returns_to_raised_rest_angle(self):
        self.assertEqual(32, self.hammer_angle_at(1.0))

    def test_hammer_angle_follows_lift_drop_bounce_sequence(self):
        self.assertEqual(32, self.hammer_angle_at(0.0))
        self.assertEqual(40, self.hammer_angle_at(0.18))
        self.assertEqual(5, self.hammer_angle_at(0.52))
        self.assertEqual(24, self.hammer_angle_at(0.78))
        self.assertEqual(32, self.hammer_angle_at(1.0))


if __name__ == '__main__':
    unittest.main()
