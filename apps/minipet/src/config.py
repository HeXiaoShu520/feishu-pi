# coding:utf-8
"""
MiniPet 全局配置模块。

职责：
- 维护项目路径常量，例如资源目录、数据目录和历史 .env 文件位置。
- 定义各功能模块的默认配置。
- 从设置 JSON 加载配置，并兼容迁移历史 .env 配置。
- 保存设置页产生的配置变更。

运行时配置唯一来源：data/minipet_settings.json；历史 .env 只用于一次性迁移。
"""

import json
from pathlib import Path

from PySide6.QtCore import QLocale

ROOT_DIR = Path(__file__).resolve().parents[1]
RES_DIR = ROOT_DIR / 'res'
DATA_DIR = ROOT_DIR / 'data'
AVATARS_DIR = DATA_DIR / 'avatars'
SETTINGS_FILE = DATA_DIR / 'minipet_settings.json'

# 冷连接握手时是否显示"正在连接语音服务"动画；
# 直连后握手约 200ms，动画暂时关闭，需要时改回 True 即可
ASR_CONNECTING_ANIMATION = False
DEFAULT_THEME_COLOR = '#009faa'
SCREEN_SHARE_ENABLED = False
APP_DISPLAY_NAME = 'MiniPet'
APP_ID = 'minipet'

TRUE_VALUES = {'1', 'true', 'yes', 'on'}   # 布尔配置的“真”字面量集合
FALSE_VALUES = {'0', 'false', 'no', 'off'}  # 布尔配置的“假”字面量集合

DEFAULT_APP_CONFIG = {
    # 这两个行为固定开启，不再通过设置页或 .env 暴露，避免桌宠行为被配置成不一致。
    'on_top': True,      # 宠物窗口置顶：始终显示在其他窗口上方
    'allow_drop': True,  # 允许宠物掉落：释放鼠标后掉落到屏幕底部
    'volume': 0.4,       # 高级参数：通过 APP_VOLUME 配置，不在设置页展示
    'language_code': QLocale().name(),
    'theme_color': None,
    'default_pet': '',
    'pet_name': '',
    'scale': 1.0,        # 高级参数：通过 APP_SCALE 配置，不在设置页展示
    'pet_avatar': '',
    'user_avatar': 'user_avatar_5.png',  # 默认使用 3x3 头像切片的中心图
    'auto_start': False,   # 系统启动时自动运行（写入注册表 Run 键）
    'pet_auto_switch_minutes': 0,  # 每 N 分钟随机切换宠物形象，0 为关闭
    'app_theme': 'aurora',
    'reply_card_style': 'aurora',
    'voice_orb_style': 'jade',
    'voice_follow_effect': 'spring',
}

DEFAULT_TTS_CONFIG = {
    'enabled': False,               # 是否启用豆包 TTS 朗读
    'api_key': '',
    'voice_name': 'zh_female_vv_uranus_bigtts',  # 默认音色
    'max_chars': 200,               # 单次朗读的最大文本长度
    'test_text': '',
    'disable_emoji_filter': True,   # 是否跳过 emoji 过滤
    'max_length_to_filter_parenthesis': 100,  # 超过该长度才过滤括号内容
}

ASR_RECORDING_MAX_MS = 5 * 60 * 1000  # 单次语音识别录音上限：5 分钟

DEFAULT_VOICE_CHAT_CONFIG = {
    'continuous': False,
}

DEFAULT_WAKE_WORD_CONFIG = {
    'enabled': False,     # 是否启用离线唤醒词
    'words': '小月小月',
    'template_path': 'data/wake_word_templates/default.json',
    'sample_rate': 16000,  # 唤醒模型要求的采样率
    'chunk_ms': 80,        # 每个音频块时长
    'window_ms': 2400,     # 唤醒检测滑窗时长
    'threshold': 0.50,     # 唤醒判定相似度阈值
    'confirm_count': 1,    # 连续命中次数达到该值才确认唤醒
    'cooldown_ms': 1800,   # 唤醒后的冷却时间，防止重复触发
    'restart_delay_ms': 1200,  # 检测器重启延迟
    'weight': 2.0,         # 唤醒词关键词权重，越高越容易命中（误触也随之上升）
}

DEFAULT_DAILY_INPUT_CONFIG = {
    'enabled': False,      # 中键语音输入总开关
    'inject_mode': 'paste',  # typing=模拟打字 / paste=复制粘贴（推荐）
    'hotkey': 'mouse:middle',  # 触发键：mouse:middle（鼠标中键）或 key:f8 等按键
}

DEFAULT_TYPEWRITER_CONFIG = {
    'enabled': True,           # 回复是否逐字打字机效果显示
    'speed_ms': 28,            # 每字间隔毫秒数
    'max_duration_ms': 5000,   # 打字动画总时长上限
    'tts_delay_ms': 500,       # 打字动画相对 TTS 播放的延迟
}

TTS_LEGACY_ENV_KEYS = {
    'TTS_ENABLED',
    'TTS_VOICE_NAME',
    'TTS_MAX_CHARS',
    'TTS_TEST_TEXT',
    'VOICE_CHAT_CONTINUOUS',
    'WAKE_WORD_ENABLED',
    'WAKE_WORDS',
    'WAKE_WORD_MODEL_DIR',
    'WAKE_WORD_SAMPLE_RATE',
    'WAKE_WORD_CHUNK_MS',
    'WAKE_WORD_RESTART_DELAY_MS',
    'DAILY_INPUT_ENABLED',
    'TYPEWRITER_ENABLED',
    'TYPEWRITER_SPEED_MS',
    'TYPEWRITER_MAX_DURATION_MS',
    'TYPEWRITER_TTS_DELAY_MS',
    'APP_VOLUME',
    'APP_SCALE',
    'CHAT_RESTORE_ENABLED',
    'CHAT_RESTORE_MAX_MESSAGES',
    'CHAT_RESTORE_MAX_DAYS',
    'REALTIME_ENABLED',
    'REALTIME_MODEL',
    'REALTIME_SPEAKER',
    'REALTIME_BOT_NAME',
    'REALTIME_SYSTEM_ROLE',
    'REALTIME_SPEAKING_STYLE',
}

app_config = dict(DEFAULT_APP_CONFIG)
tts_config = dict(DEFAULT_TTS_CONFIG)
voice_chat_config = dict(DEFAULT_VOICE_CHAT_CONFIG)
typewriter_config = dict(DEFAULT_TYPEWRITER_CONFIG)
wake_word_config = dict(DEFAULT_WAKE_WORD_CONFIG)
daily_input_config = dict(DEFAULT_DAILY_INPUT_CONFIG)

# 桌宠窗口运行态。历史代码直接从 config 模块读写这些状态，先保留集中入口。
current_image = None
previous_anchor = [0, 0]
current_anchor = [0, 0]
screens = []
current_screen = None
on_floor = True
dragging = False
drag_speed_x = 0.0
drag_speed_y = 0.0
fall_right = False
play_id = 0
act_id = 0
current_pet = ''


def ensure_data_dir():
    """确保 data 目录存在。"""
    DATA_DIR.mkdir(exist_ok=True)


def avatar_path(kind):
    """
    返回用户或宠物头像路径。

    优先使用 data/avatars 中的自定义头像；宠物头像未配置时回退到当前角色
    的 res/role/<pet>/info/pfp.png；再失败则使用内置默认图标。
    """
    key = 'user_avatar' if kind == 'user' else 'pet_avatar'
    filename = str(app_config.get(key, '') or '').strip()
    if filename:
        path = AVATARS_DIR / filename
        if path.is_file():
            return path
    if kind == 'pet' and current_pet:
        profile_path = pet_model_image_path(current_pet)
        if profile_path.is_file():
            return profile_path
    return RES_DIR / 'icons' / 'character.svg'


def _image_suffixes():
    """返回允许扫描的图片扩展名集合。"""
    return ('.png', '.jpg', '.jpeg', '.webp', '.bmp')


def _same_stem_image(path):
    """在路径同名前提下尝试其他扩展名，找到已存在的图片则返回。"""
    for suffix in _image_suffixes():
        candidate = path.with_suffix(suffix)
        if candidate.is_file():
            return candidate
    return None


def _first_image_by_key(role_dir, image_key):
    """按动作 key 在 action 目录中定位第一张可用帧图。"""
    image_key = str(image_key or '').strip()
    if not image_key:
        return None
    action_dir = role_dir / 'action'
    for suffix in _image_suffixes():
        for name in (f'{image_key}_0{suffix}', f'{image_key}{suffix}'):
            candidate = action_dir / name
            if candidate.is_file():
                return candidate
    matches = []
    for suffix in _image_suffixes():
        matches.extend(action_dir.glob(f'{image_key}_*{suffix}'))
    return sorted(matches)[0] if matches else None


def _pet_default_action_image_path(role_dir):
    """读取 pet_conf/act_conf，返回角色默认动作的第一帧图路径。"""
    pet_conf_file = role_dir / 'pet_conf.json'
    act_conf_file = role_dir / 'act_conf.json'
    if not pet_conf_file.is_file() or not act_conf_file.is_file():
        return None
    try:
        pet_conf = json.loads(pet_conf_file.read_text(encoding='utf-8'))
        act_conf = json.loads(act_conf_file.read_text(encoding='utf-8'))
    except Exception:
        return None
    default_act = str(pet_conf.get('default') or 'default')
    act_data = act_conf.get(default_act) or {}
    image_key = act_data.get('images') or default_act
    return _first_image_by_key(role_dir, image_key)


def pet_model_image_path(pet_name):
    """返回角色模型自己的默认展示图。"""
    role_dir = RES_DIR / 'role' / str(pet_name or '')
    fallback = RES_DIR / 'icons' / 'character.svg'
    info_dir = role_dir / 'info'
    if info_dir.is_dir():
        info_file = info_dir / 'info.json'
        info = {}
        if info_file.is_file():
            try:
                info = json.loads(info_file.read_text(encoding='utf-8'))
            except Exception:
                info = {}
        pfp = str(info.get('pfp') or '').strip()
        if pfp:
            path = info_dir / pfp
            if path.is_file():
                return path
            same_stem = _same_stem_image(path)
            if same_stem is not None:
                return same_stem

        for cover in info.get('coverImages') or []:
            path = info_dir / str(cover)
            if path.is_file():
                return path
            same_stem = _same_stem_image(path)
            if same_stem is not None:
                return same_stem

        pfp_path = info_dir / 'pfp.png'
        if pfp_path.is_file():
            return pfp_path
        for suffix in ('*.png', '*.jpg', '*.jpeg', '*.webp', '*.bmp'):
            matches = sorted(info_dir.glob(suffix))
            if matches:
                return matches[0]

    action_image = _pet_default_action_image_path(role_dir)
    if action_image is not None:
        return action_image

    for suffix in _image_suffixes():
        try:
            match = next((role_dir / 'action').glob(f'*{suffix}'))
            return match
        except Exception:
            pass
    return fallback


def pet_display_name():
    """返回界面和聊天中展示的宠物名字，未设置时回退到当前角色目录名。"""
    return str(app_config.get('pet_name') or current_pet or '宠物').strip() or '宠物'


def get_pet_list():
    """扫描 res/role，返回包含 pet_conf.json 的可用角色名。"""
    role_dir = RES_DIR / 'role'
    if not role_dir.exists():
        return []
    pets = []
    for child in role_dir.iterdir():
        if child.is_dir() and child.name != 'sys' and (child / 'pet_conf.json').exists():
            pets.append(child.name)
    return sorted(pets)


def _coerce_env_value(value, default):
    """按默认值类型把配置值转换成 bool/int/float/str。"""
    if isinstance(default, bool):
        normalized = str(value).strip().lower()
        if normalized in TRUE_VALUES:
            return True
        if normalized in FALSE_VALUES:
            return False
        return default
    if isinstance(default, int) and not isinstance(default, bool):
        try:
            return int(value)
        except (TypeError, ValueError):
            return default
    if isinstance(default, float):
        try:
            return float(value)
        except (TypeError, ValueError):
            return default
    return value


def _load_json_config(defaults, settings, section_key):
    """从 minipet_settings.json 的子 key 读取一组配置。"""
    cfg = dict(defaults)
    data = settings.get(section_key)
    if isinstance(data, dict):
        for k, v in data.items():
            if k in defaults:
                cfg[k] = _coerce_env_value(v, defaults[k])
    return cfg


def load():
    """加载所有配置，并初始化当前宠物等运行时状态。"""
    global app_config, tts_config, voice_chat_config, typewriter_config, wake_word_config, daily_input_config, current_pet
    ensure_data_dir()
    pets = get_pet_list()

    settings = {}
    if SETTINGS_FILE.is_file():
        try:
            settings = json.loads(SETTINGS_FILE.read_text(encoding='utf-8'))
        except Exception:
            pass

    app_config = dict(DEFAULT_APP_CONFIG)
    app_config.update({k: v for k, v in settings.items() if not isinstance(v, dict)})

    # 固定置顶和掉落配置，不允许旧 JSON、环境变量或设置页覆盖。
    app_config['on_top'] = True
    app_config['allow_drop'] = True
    app_config.pop('voice_follow_level', None)
    # 将旧的 reply_card_style/voice_orb_style 迁移到统一的 app_theme
    if not app_config.get('app_theme'):
        from theme import migrate_legacy_theme
        migrate_legacy_theme()
    # 旧版本的后端选择、模型地址和项目配置不再参与运行时。
    for key in (
        'codex_project_dir', 'codex_reset_token', 'codex_thread_ids',
        'openclaw_api_url', 'openclaw_model', 'openclaw_user', 'openclaw_timeout',
        'claude_code_project_dir', 'claude_code_reset_token', 'claude_code_known_sessions',
        'agent_backend', 'custom_agent_ws_url',
    ):
        app_config.pop(key, None)

    if not app_config.get('default_pet') and pets:
        app_config['default_pet'] = pets[0]
    if app_config.get('default_pet') not in pets and pets:
        app_config['default_pet'] = pets[0]
    current_pet = app_config.get('default_pet') or ''

    tts_config = _load_json_config(DEFAULT_TTS_CONFIG, settings, 'tts')
    voice_chat_config = _load_json_config(DEFAULT_VOICE_CHAT_CONFIG, settings, 'voice_chat')
    typewriter_config = _load_json_config(DEFAULT_TYPEWRITER_CONFIG, settings, 'typewriter')
    wake_word_config = _load_json_config(DEFAULT_WAKE_WORD_CONFIG, settings, 'wake_word')
    daily_input_config = _load_json_config(DEFAULT_DAILY_INPUT_CONFIG, settings, 'daily_input')
    # 旧版没有 inject_mode 字段：默认迁移为复制粘贴
    if 'inject_mode' not in (settings.get('daily_input') or {}):
        daily_input_config['inject_mode'] = 'paste'
    save_app_config()


def _save_settings_file():
    """将所有配置合并写入 minipet_settings.json。"""
    ensure_data_dir()
    data = dict(app_config)
    data['tts'] = dict(tts_config)
    data['voice_chat'] = dict(voice_chat_config)
    data['typewriter'] = dict(typewriter_config)
    data['wake_word'] = dict(wake_word_config)
    data['daily_input'] = dict(daily_input_config)
    SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def save_app_config():
    """保存基础设置到 data/minipet_settings.json。"""
    _save_settings_file()


def save_tts_config(config):
    """保存 TTS 配置到设置 JSON。"""
    global tts_config
    tts_config = {**tts_config, **dict(config)}
    _save_settings_file()


def save_typewriter_config(config):
    """保存回复逐字显示配置到 JSON。"""
    global typewriter_config
    typewriter_config = dict(config)
    _save_settings_file()


def save_voice_chat_config(config):
    """保存本地 AI 语音聊天配置到 JSON。"""
    global voice_chat_config
    voice_chat_config = dict(config)
    _save_settings_file()


def save_wake_word_config(config):
    """保存离线唤醒词配置到 JSON。"""
    global wake_word_config
    wake_word_config = dict(config)
    _save_settings_file()


def save_daily_input_config(config):
    """保存日常工作语音输入配置到 JSON。"""
    global daily_input_config
    daily_input_config = dict(config)
    _save_settings_file()
