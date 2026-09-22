# coding:utf-8

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src import config


class ConfigMigrationTest(unittest.TestCase):
    def test_load_removes_legacy_codex_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            settings_file = Path(directory) / 'minipet_settings.json'
            settings_file.write_text(json.dumps({
                'agent_backend': 'codex',
                'codex_project_dir': 'C:/project',
                'codex_reset_token': 3,
                'codex_thread_ids': {'C:/project#reset:3': 'thread'},
                'pet_name': '测试宠物',
            }), encoding='utf-8')

            with patch.object(config, 'SETTINGS_FILE', settings_file), patch.object(config, 'DATA_DIR', Path(directory)):
                config.load()

            saved = json.loads(settings_file.read_text(encoding='utf-8'))
            self.assertNotIn('agent_backend', config.app_config)
            self.assertEqual('测试宠物', config.app_config['pet_name'])
            self.assertNotIn('codex_project_dir', saved)
            self.assertNotIn('codex_reset_token', saved)
            self.assertNotIn('codex_thread_ids', saved)


if __name__ == '__main__':
    unittest.main()
