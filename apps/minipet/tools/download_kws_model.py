# coding:utf-8
"""下载 sherpa-onnx 中文 KWS 唤醒词模型到 models/ 目录。

模型体积约 40MB 且为二进制，不入 git 仓库；
本脚本供用户在新环境一键获取。默认走本地代理，可用 --no-proxy 关闭。

用法：
    python tools/download_kws_model.py            # 使用本地代理 127.0.0.1:6864
    python tools/download_kws_model.py --no-proxy # 直连
"""

import argparse
import subprocess
import sys
import tarfile
from pathlib import Path

# 中文 KWS 模型（Zipformer 3.3M，WenetSpeech 训练），来自 k2-fsa 官方 release
MODEL_NAME = 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01'
DOWNLOAD_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/%s.tar.bz2' % MODEL_NAME
DEFAULT_PROXY = 'http://127.0.0.1:6864'
# 模型目录必须存在这些文件才认为解压完整
REQUIRED_FILES = ('tokens.txt', 'keywords.txt', 'encoder-epoch-99-avg-1-chunk-16-left-64.onnx')


def main():
    """下载并解压模型；目录已完整时直接跳过。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--no-proxy', action='store_true', help='不走本地代理直连下载')
    args = parser.parse_args()

    models_dir = Path(__file__).resolve().parents[1] / 'models'
    target = models_dir / MODEL_NAME
    if target.is_dir() and all((target / name).is_file() for name in REQUIRED_FILES):
        print('模型已存在：%s' % target)
        return

    models_dir.mkdir(parents=True, exist_ok=True)
    archive = models_dir / (MODEL_NAME + '.tar.bz2')
    proxy = [] if args.no_proxy else ['-x', DEFAULT_PROXY]
    print('下载 %s ...' % DOWNLOAD_URL)
    result = subprocess.run(
        ['curl', *proxy, '-L', '-o', str(archive), DOWNLOAD_URL, '-sS', '--fail'],
    )
    if result.returncode != 0:
        print('下载失败，请检查网络或代理后重试', file=sys.stderr)
        sys.exit(1)

    print('解压到 %s ...' % models_dir)
    with tarfile.open(archive, 'r:bz2') as bundle:
        bundle.extractall(models_dir)
    archive.unlink()
    print('完成：%s' % target)


if __name__ == '__main__':
    main()
