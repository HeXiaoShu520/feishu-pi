# coding:utf-8
"""sherpa-onnx KWS 唤醒模块的单元测试。

不依赖真实模型与麦克风：验证模型定位、路径解析、
错误提示和信号接口。
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from clients.kws_client import (
    KwsError, SherpaKwsWorker, find_model_dir, resolve_keywords_path,
    words_to_keyword_line, write_keywords_file,
)


class KwsClientTest(unittest.TestCase):
    def setUp(self):
        """每个用例使用独立临时目录，避免真实 models/ 干扰。"""
        import tempfile
        self.root = Path(tempfile.mkdtemp())

    def test_find_model_dir_returns_none_when_missing(self):
        """models/ 不存在或不含完整模型时应返回 None。"""
        self.assertIsNone(find_model_dir(self.root / 'models'))
        empty = self.root / 'models' / 'empty'
        empty.mkdir(parents=True)
        self.assertIsNone(find_model_dir(self.root / 'models'))

    def test_find_model_dir_detects_complete_model(self):
        """同时包含 tokens.txt 与 keywords.txt 的目录视为完整模型。"""
        model = self.root / 'models' / 'some-kws-model'
        model.mkdir(parents=True)
        (model / 'tokens.txt').write_text('', encoding='utf-8')
        (model / 'keywords.txt').write_text('', encoding='utf-8')
        self.assertEqual(model, find_model_dir(self.root / 'models'))

    def test_resolve_keywords_path_default(self):
        """未配置 kws_keywords_path 时应解析到默认 res/wake/keywords.txt。"""
        resolved = resolve_keywords_path('', self.root)
        self.assertTrue(resolved.is_absolute())
        self.assertEqual('keywords.txt', resolved.name)

    def test_build_spotter_requires_sherpa(self):
        """sherpa_onnx 缺失时构建引擎应抛出带安装提示的错误。"""
        worker = SherpaKwsWorker({}, root_dir=str(self.root))
        with patch('clients.kws_client.sherpa_onnx', None):
            with self.assertRaises(KwsError):
                worker._build_keyword_spotter()

    def test_build_spotter_requires_model(self):
        """models/ 下没有完整模型时构建引擎应提示运行下载脚本。"""
        worker = SherpaKwsWorker({}, root_dir=str(self.root))
        with patch('clients.kws_client.sherpa_onnx', object()):
            with self.assertRaises(KwsError) as ctx:
                worker._build_keyword_spotter()
        self.assertIn('download_kws_model', str(ctx.exception))

    def test_lifecycle_signals_exist(self):
        """Worker 必须保持 detected/status/error 信号与 pause/resume/stop 接口。"""
        worker = SherpaKwsWorker({}, root_dir=str(self.root))
        for name in ('detected', 'status_changed', 'error_received'):
            self.assertTrue(hasattr(worker, name))
        worker.pause()
        worker.resume()
        worker.stop()
        self.assertFalse(worker.running)

    def test_words_to_keyword_line(self):
        """中文唤醒词应转换为声韵母 token + 原词标注 + 权重的 keywords 行。"""
        line = words_to_keyword_line('小月小月')
        self.assertEqual('x iǎo y uè x iǎo y uè @小月小月 :2.0', line)

    def test_write_keywords_file_multi_words(self):
        """多唤醒词应逐词成行写入文件，分隔符支持中英文逗号与空格。"""
        target = self.root / 'data' / 'wake_word_keywords.txt'
        written = write_keywords_file(target, '小月小月，你好问问 小艺小艺')
        self.assertEqual(['小月小月', '你好问问', '小艺小艺'], written)
        lines = target.read_text(encoding='utf-8').strip().splitlines()
        self.assertEqual(3, len(lines))
        self.assertTrue(lines[1].endswith('@你好问问 :2.0'))
        self.assertTrue(lines[2].endswith('@小艺小艺 :2.0'))

    def test_write_keywords_file_with_weight(self):
        """自定义权重应写入关键词行"""
        target = self.root / 'data' / 'wake_word_keywords.txt'
        write_keywords_file(target, '小呆', weight=2.5)
        content = target.read_text(encoding='utf-8').strip()
        self.assertTrue(content.endswith('@小呆 :2.5'), content)

    def test_write_keywords_file_rejects_empty(self):
        """空唤醒词输入应抛出可读错误而不是写坏文件。"""
        with self.assertRaises(KwsError):
            write_keywords_file(self.root / 'kw.txt', '  ')


if __name__ == '__main__':
    unittest.main()
