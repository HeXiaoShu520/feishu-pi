# coding:utf-8
"""
角色资源加载模块。

负责读取 res/role/<pet>/pet_conf.json、动作帧图片和锚点配置，组装成
PetProfile/Act。DesktopPet 和 AnimationWorker 只消费这里返回的结构化对象。
"""

import glob
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from PySide6.QtCore import QRect
from PySide6.QtGui import QBitmap, QImage, QPixmap, QRegion

import config


CODEX_V2_ROW_ALIASES = {
    # 老版动作名到 v2 雪碧图固定行名的映射
    'default': 'idle',
    'stand': 'idle',
    'idle': 'idle',
    'running-right': 'running-right',
    'right_walk': 'running-right',
    'rightwalk': 'running-right',
    'running-left': 'running-left',
    'left_walk': 'running-left',
    'leftwalk': 'running-left',
    'waving': 'waving',
    'jumping': 'jumping',
    'failed': 'failed',
    'waiting': 'waiting',
    'running': 'running',
    'review': 'review',
}

CODEX_V2_DEFAULT_ROWS = [
    # v2 雪碧图从上到下的固定动作行顺序
    'idle',
    'running-right',
    'running-left',
    'waving',
    'jumping',
    'failed',
    'waiting',
    'running',
    'review',
]


def _pixmap_bounds(pixmap):
    """计算 pixmap 中非透明区域的 bounding box（原始像素坐标）。

    优先用 numpy 向量化计算，速度比逐像素扫描快数十倍。
    没有 numpy 时退回 Qt 的 alpha 掩码求边界（约 0.06ms/帧），
    结果会缓存避免重复计算同一 pixmap。
    """
    # 用 pixmap 的 cacheKey 做缓存键，同一图片只算一次
    cache_key = pixmap.cacheKey()
    if hasattr(_pixmap_bounds, '_cache'):
        cached = _pixmap_bounds._cache.get(cache_key)
        if cached is not None:
            return cached
    else:
        _pixmap_bounds._cache = {}

    image = pixmap.toImage().convertToFormat(QImage.Format.Format_ARGB32)
    try:
        import numpy as np
        ptr = image.bits()
        arr = np.frombuffer(ptr, dtype=np.uint8).reshape(image.height(), image.width(), 4)
        alpha = arr[:, :, 3]
        rows = np.any(alpha > 0, axis=1)
        cols = np.any(alpha > 0, axis=0)
        if not rows.any():
            result = (0, 0, image.width(), image.height())
        else:
            top = int(np.argmax(rows))
            bottom = int(len(rows) - 1 - np.argmax(rows[::-1]))
            left = int(np.argmax(cols))
            right = int(len(cols) - 1 - np.argmax(cols[::-1]))
            result = (left, top, right - left + 1, bottom - top + 1)
    except ImportError:
        rect = QRegion(QBitmap.fromImage(image.createAlphaMask())).boundingRect()
        if rect.isEmpty():
            result = (0, 0, image.width(), image.height())
        else:
            result = (rect.left(), rect.top(), rect.width(), rect.height())

    # 缓存结果，限制缓存大小防止内存泄漏（角色切换时旧帧会被丢弃）
    if len(_pixmap_bounds._cache) > 200:
        _pixmap_bounds._cache.clear()
    _pixmap_bounds._cache[cache_key] = result
    return result


@dataclass
class Act:
    """单个动作的帧序列及运动参数。

    bounds 存储每帧非透明区域，用于精确碰撞和锚点定位，
    而不是依赖整张 pixmap 尺寸，避免大量透明边距干扰交互。
    """
    name: str = ''
    images: list = field(default_factory=list)
    act_num: int = 1
    direction: str = None
    frame_move: float = 0.0
    frame_refresh: float = 0.5
    anchor: list = field(default_factory=lambda: [0, 0])
    bounds: list = field(default_factory=list)  # per-frame (left,top,w,h) in original pixels

    def get_bounds(self, pixmap, scale):
        idx = id(pixmap)
        for pid, rect in self.bounds:
            if pid == idx:
                l, t, w, h = rect
                return QRect(int(l * scale), int(t * scale), max(1, int(w * scale)), max(1, int(h * scale)))
        return QRect(0, 0, max(1, int(pixmap.width() * scale)), max(1, int(pixmap.height() * scale)))


@dataclass
class PetProfile:
    name: str
    width: int
    height: int
    scale: float
    refresh: float
    interact_speed: int
    acts: dict
    default: Act
    drag: Act
    fall: Act
    prefall: Act
    on_floor: Act
    patpat: dict
    random_acts: list
    accessory_acts: dict


def _load_json(path):
    """读取一个 UTF-8 JSON 文件。"""
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def _frame_files(role_dir: Path, image_key: str):
    """按帧序号升序返回某动作的全部帧图片路径。"""
    pattern = str(role_dir / 'action' / f'{image_key}_*.png')
    files = glob.glob(pattern)
    def frame_index(path):
        match = re.search(r'_(\d+)\.png$', os.path.basename(path))
        return int(match.group(1)) if match else 0
    return sorted(files, key=frame_index)


def _load_pixmaps(role_dir: Path, image_key: str):
    """加载动作帧图；无 _N 帧序列时回退到单张同名图片。"""
    files = _frame_files(role_dir, image_key)
    if not files:
        direct = role_dir / 'action' / f'{image_key}.png'
        if direct.exists():
            files = [str(direct)]
    pixmaps = []
    for file_path in files:
        pixmap = QPixmap(file_path)
        if not pixmap.isNull():
            pixmaps.append(pixmap)
    return pixmaps


def _find_codex_v2_spritesheet(role_dir: Path, pet_conf: dict):
    """定位 v2 雪碧图文件：优先用配置指定的路径，再按常见命名探测。"""
    configured = pet_conf.get('spritesheet') or pet_conf.get('atlas') or pet_conf.get('image')
    candidates = []
    if configured:
        path = Path(str(configured))
        candidates.append(path if path.is_absolute() else role_dir / path)
    for name in ('spritesheet.webp', 'spritesheet.png', 'atlas.webp', 'atlas.png'):
        candidates.append(role_dir / name)
        candidates.append(role_dir / 'action' / name)
    for path in candidates:
        if path.is_file():
            return path
    return None


def _load_codex_v2_pixmaps(role_dir: Path, pet_conf: dict):
    """按行列切割雪碧图，返回 {行号: 帧列表} 及单元格尺寸。"""
    # Codex v2 把所有动作行排在同一张雪碧图里，按行列切割比逐文件加载 IO 更少。
    sheet_path = _find_codex_v2_spritesheet(role_dir, pet_conf)
    if sheet_path is None:
        raise FileNotFoundError(f'Codex v2 spritesheet not found: {role_dir.name}')
    sheet = QPixmap(str(sheet_path))
    if sheet.isNull():
        raise FileNotFoundError(f'Codex v2 spritesheet cannot be loaded: {sheet_path}')
    cell_width = int(pet_conf.get('cell_width') or pet_conf.get('cellWidth') or 192)
    cell_height = int(pet_conf.get('cell_height') or pet_conf.get('cellHeight') or 208)
    columns = int(pet_conf.get('columns') or pet_conf.get('cols') or 8)
    rows = int(pet_conf.get('rows') or 11)
    if sheet.width() < columns * cell_width or sheet.height() < rows * cell_height:
        raise ValueError(f'Codex v2 spritesheet size mismatch: {sheet_path}')
    row_frames = {}
    for row_index in range(rows):
        frames = []
        for column in range(columns):
            frames.append(sheet.copy(column * cell_width, row_index * cell_height, cell_width, cell_height))
        row_frames[row_index] = frames
    return row_frames, cell_width, cell_height


def _make_codex_v2_act(name: str, row_frames: dict, row_index: int, data: dict, scale: float):
    """从雪碧图指定行组装一个 Act，并按 scale 缩放运动参数。"""
    images = list(row_frames.get(row_index, []))
    if not images:
        raise FileNotFoundError(f'Codex v2 row not found: {name}')
    bounds = [(id(p), _pixmap_bounds(p)) for p in images]
    return Act(
        name=name,
        images=images,
        act_num=int(data.get('act_num', 1)),
        direction=data.get('direction'),
        frame_move=float(data.get('frame_move', 0)) * scale,
        frame_refresh=float(data.get('frame_refresh', 0.12)),
        anchor=[int(v * scale) for v in data.get('anchor', [0, 0])],
        bounds=bounds,
    )


def _make_act(role_dir: Path, name: str, data: dict, scale: float):
    """从独立帧文件组装标准格式的 Act。"""
    images = _load_pixmaps(role_dir, data.get('images', name))
    if not images:
        raise FileNotFoundError(f'Action images not found: {role_dir.name}/{name}')
    bounds = [(id(p), _pixmap_bounds(p)) for p in images]
    return Act(
        name=name,
        images=images,
        act_num=int(data.get('act_num', 1)),
        direction=data.get('direction'),
        frame_move=float(data.get('frame_move', 0)) * scale,
        frame_refresh=float(data.get('frame_refresh', 0.5)),
        anchor=[int(v * scale) for v in data.get('anchor', [0, 0])],
        bounds=bounds,
    )


def _fill_patpat(raw, acts):
    """把 patpat 配置统一展开为 4 个抚摸阶段各自对应的 Act。"""
    # patpat 配置支持字符串（所有阶段用同一动作）和 dict（按抚摸阶段分别指定）两种格式，
    # 这里统一展开成 {0..3: Act} 方便动画系统按阶段索引。
    if isinstance(raw, str):
        return {i: acts.get(raw) or next(iter(acts.values())) for i in range(4)}
    if isinstance(raw, dict):
        filled = {}
        last = None
        for i in range(4):
            key = str(i)
            if key in raw:
                last = raw[key]
            filled[i] = acts.get(last) if last else next(iter(acts.values()))
        return filled
    return {i: next(iter(acts.values())) for i in range(4)}


def _load_standard_pet_acts(role_dir: Path, pet_conf: dict, act_conf: dict, scale: float):
    """加载标准格式角色的全部动作，缺图的动作静默跳过。"""
    acts = {}
    for name, data in act_conf.items():
        try:
            acts[name] = _make_act(role_dir, name, data, scale)
        except FileNotFoundError:
            pass
    return acts


def _load_codex_v2_acts(role_dir: Path, pet_conf: dict, act_conf: dict, scale: float):
    """加载 v2 雪碧图角色的全部动作并补齐 drag/fall 等别名动作。"""
    # Codex v2 行名固定，先按默认行顺序批量加载，再用 act_conf 中的 codex_row/row 字段覆盖或扩展。
    # aliases 确保老版 act_conf 里的通用名（drag、fall 等）在 v2 雪碧图里也能找到对应帧。
    acts = {}
    row_frames, _, _ = _load_codex_v2_pixmaps(role_dir, pet_conf)
    for name, row_name in zip(CODEX_V2_DEFAULT_ROWS, CODEX_V2_DEFAULT_ROWS):
        row_index = CODEX_V2_DEFAULT_ROWS.index(row_name)
        data = dict(act_conf.get(name, {}))
        data.setdefault('images', name)
        acts[name] = _make_codex_v2_act(name, row_frames, row_index, data, scale)
    for name, data in act_conf.items():
        row_name = data.get('codex_row') or data.get('row_name') or CODEX_V2_ROW_ALIASES.get(data.get('images', name), data.get('images', name))
        if row_name in CODEX_V2_DEFAULT_ROWS:
            row_index = CODEX_V2_DEFAULT_ROWS.index(row_name)
        elif isinstance(data.get('row'), int):
            row_index = int(data.get('row'))
        else:
            continue
        acts[name] = _make_codex_v2_act(name, row_frames, row_index, data, scale)
    aliases = {
        'default': 'idle',
        'stand': 'idle',
        'drag': 'idle',
        'fall': 'failed',
        'prefall': 'failed',
        'onfloor': 'idle',
        'patpat': 'waving',
        'happy': 'waving',
        'work': 'running',
        'left_walk': 'running-left',
        'right_walk': 'running-right',
    }
    for alias, target in aliases.items():
        if alias not in acts and target in acts:
            acts[alias] = acts[target]
    return acts


def load_pet_preview(pet_name: str):
    """只加载角色默认动作的第一帧，用于切换时立即显示预览。"""
    role_dir = config.RES_DIR / 'role' / pet_name
    pet_conf = _load_json(role_dir / 'pet_conf.json')
    act_conf_path = role_dir / 'act_conf.json'
    act_conf = _load_json(act_conf_path) if act_conf_path.is_file() else {}
    scale = float(pet_conf.get('scale', 1.0))
    default_name = str(pet_conf.get('default') or 'default')
    data = dict(act_conf.get(default_name) or {})
    if int(pet_conf.get('spriteVersionNumber', pet_conf.get('sprite_version_number', 0)) or 0) == 2:
        sheet_path = _find_codex_v2_spritesheet(role_dir, pet_conf)
        sheet = QPixmap(str(sheet_path))
        cell_width = int(pet_conf.get('cell_width') or pet_conf.get('cellWidth') or 192)
        cell_height = int(pet_conf.get('cell_height') or pet_conf.get('cellHeight') or 208)
        row_name = data.get('codex_row') or data.get('row_name') or data.get('images') or default_name
        row_index = CODEX_V2_DEFAULT_ROWS.index(row_name) if row_name in CODEX_V2_DEFAULT_ROWS else int(data.get('row', 0))
        return sheet.copy(0, row_index * cell_height, cell_width, cell_height), [int(v * scale) for v in data.get('anchor', [0, 0])]
    image_key = str(data.get('images') or default_name)
    images = _load_pixmaps(role_dir, image_key)
    if not images:
        raise FileNotFoundError('默认动作没有可用图片: %s' % pet_name)
    return images[0], [int(v * scale) for v in data.get('anchor', [0, 0])]


def load_pet_profile(pet_name: str):
    """加载完整角色资源，组装出动画系统所需的 PetProfile。"""
    role_dir = config.RES_DIR / 'role' / pet_name
    pet_conf = _load_json(role_dir / 'pet_conf.json')
    act_conf_path = role_dir / 'act_conf.json'
    act_conf = _load_json(act_conf_path) if act_conf_path.is_file() else {}
    scale = float(pet_conf.get('scale', 1.0))
    is_codex_v2 = int(pet_conf.get('spriteVersionNumber', pet_conf.get('sprite_version_number', 0)) or 0) == 2
    if is_codex_v2:
        acts = _load_codex_v2_acts(role_dir, pet_conf, act_conf, scale)
        default_width = int(pet_conf.get('cell_width') or pet_conf.get('cellWidth') or 192)
        default_height = int(pet_conf.get('cell_height') or pet_conf.get('cellHeight') or 208)
    else:
        acts = _load_standard_pet_acts(role_dir, pet_conf, act_conf, scale)
        default_width = 128
        default_height = 128

    def act(name, fallback='default'):
        """按 pet_conf 中的 key 取动作，逐级回退保证不返回缺动作。"""
        key = pet_conf.get(name, fallback)
        return acts.get(key) or acts.get(fallback) or (next(iter(acts.values())) if acts else None)

    random_acts = []
    for item in pet_conf.get('random_act', []):
        act_list = [acts[a] for a in item.get('act_list', []) if a in acts]
        if act_list:
            random_acts.append({
                'name': item.get('name') or act_list[0].name,
                'acts': act_list,
                'prob': float(item.get('act_prob', 0.2)),
            })

    accessory_acts = {}
    for item in pet_conf.get('accessory_act', []):
        act_list = [acts[a] for a in item.get('act_list', []) if a in acts]
        acc_list = [acts[a] for a in item.get('acc_list', []) if a in acts]
        if act_list:
            accessory_acts[item.get('name') or act_list[0].name] = {
                'acts': act_list,
                'accessory_acts': acc_list,
                'anchor': [int(v * scale) for v in item.get('anchor', [0, 0])],
            }

    return PetProfile(
        name=pet_name,
        width=int(float(pet_conf.get('width', default_width)) * scale),
        height=int(float(pet_conf.get('height', default_height)) * scale),
        scale=scale,
        refresh=float(pet_conf.get('refresh', 5)),
        interact_speed=int(float(pet_conf.get('interact_speed', 0.02)) * 1000),
        acts=acts,
        default=act('default'),
        drag=act('drag'),
        fall=act('fall'),
        prefall=act('prefall', 'fall'),
        on_floor=act('on_floor', 'default'),
        patpat=_fill_patpat(pet_conf.get('patpat', 'default'), acts),
        random_acts=random_acts,
        accessory_acts=accessory_acts,
    )
