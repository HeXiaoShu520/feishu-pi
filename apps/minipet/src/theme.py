# coding:utf-8
"""
MiniPet 全局主题系统。

每个主题为所有 UI 组件提供统一色板：
  - card   : 回复卡片背景/边框
  - orb    : 语音球渐变色板 (dict, 键: bg/border/wave/dot/ring/core/core2/text)
  - orb_glow: 语音球发光颜色 (两个 QColor 参数 tuple)
  - input  : 快捷输入框 QSS
  - menu   : 菜单/拖放意图弹窗 QSS
  - easter : 彩蛋弹窗前景色 + 强调色
  - chat   : 聊天窗口头部/输入栏配色
  - accent : 主色调 (用于 theme_color 等)

调用 get_theme(name) 获取主题字典；
调用 current_theme() 获取当前应用主题。
"""

import config

# ─── 主题定义 ─────────────────────────────────────────────────────────────────

# 所有主题共享同一套键名契约，新增主题只需填入色值，无需改动任何渲染代码。
# 每个主题包含的子字典：
#   card       - 回复卡片背景/边框/文字色
#   orb        - 语音球动画色板（8个角色：背景/边框/波纹/核心等）
#   orb_glow   - 语音球光晕的两层 QColor 参数 tuple
#   input_*    - 快捷输入框各色键
#   menu_*     - 菜单/意图弹窗各色键
#   easter_*   - 彩蛋弹窗前景色 + 强调色
#   chat_*     - 聊天窗口头部/输入栏配色
#   accent     - 全局主色调（进度条、链接高亮等）
#   preview_qss- 设置页主题选择器小预览块的内联 QSS
THEMES = {
    'aurora': {
        '_label': '极光',
        'card': {
            'bg': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #fffdfa,stop:0.54 #f7fbff,stop:1 #f6f1ff)',
            'border': 'rgba(228,215,255,210)',
            'title': '#202436', 'body': '#3a4054', 'meta': '#8b93a7',
            'box_bg': '#ffffff', 'dark': False,
        },
        'orb': {
            'bg': (248, 246, 255, 246), 'border': (168, 148, 255, 238),
            'wave': (120, 100, 255, 220), 'dot': (130, 100, 255),
            'ring': (110, 180, 255), 'core': (140, 110, 255, 230),
            'core2': (210, 195, 255, 230), 'text': (35, 28, 62, 235),
        },
        'orb_glow': ((255, 255, 255, 112), (215, 200, 255, 55)),
        'input_card_bg': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 rgba(255,255,255,248),stop:1 rgba(248,246,255,242))',
        'input_card_border': 'rgba(210,200,240,235)',
        'input_dot': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #8fd3ff,stop:1 #c7a8ff)',
        'input_text': '#1f2328',
        'menu_bg': '#f0ecff',
        'menu_border': '#b8a8e8',
        'menu_btn_bg': '#ddd4ff',
        'menu_btn_hover': '#cfc4ff',
        'menu_primary': '#6655cc',
        'easter_fg': '#3a2e6e',
        'easter_accent': '#a080ff',
        'chat_header_bg': '#ffffff',
        'chat_header_border': '#e5e7eb',
        'chat_input_bg': '#f7f8fa',
        'accent': '#009faa',
        'preview_qss': 'background:qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #fffdfa,stop:0.55 #f7fbff,stop:1 #f6f1ff);border:1px solid #e4d7ff;border-radius:12px;',
    },
    'jade': {
        '_label': '玉石',
        'card': {
            'bg': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #f6fff9,stop:0.54 #edfff5,stop:1 #e0f7ee)',
            'border': 'rgba(150,225,210,220)',
            'title': '#1a3a2e', 'body': '#2d4a3e', 'meta': '#6a9e8a',
            'box_bg': '#ffffff', 'dark': False,
        },
        'orb': {
            'bg': (244, 255, 249, 246), 'border': (125, 195, 165, 238),
            'wave': (72, 172, 145, 225), 'dot': (98, 175, 150),
            'ring': (84, 190, 160), 'core': (116, 210, 178, 230),
            'core2': (225, 255, 240, 230), 'text': (30, 70, 58, 235),
        },
        'orb_glow': ((255, 255, 246, 135), (210, 246, 226, 62)),
        'input_card_bg': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 rgba(255,255,255,248),stop:1 rgba(240,255,250,242))',
        'input_card_border': 'rgba(150,210,190,235)',
        'input_dot': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #5ec9a8,stop:1 #a8e6cc)',
        'input_text': '#1a3a2e',
        'menu_bg': '#e0f7ef',
        'menu_border': '#7bc8aa',
        'menu_btn_bg': '#c0edda',
        'menu_btn_hover': '#a8e4cc',
        'menu_primary': '#28a07a',
        'easter_fg': '#1a3a2e',
        'easter_accent': '#4bc498',
        'chat_header_bg': '#f6fffe',
        'chat_header_border': '#c8e8de',
        'chat_input_bg': '#f2fbf6',
        'accent': '#2ba87e',
        'preview_qss': 'background:qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #f6fff9,stop:1 #e0f7ee);border:1px solid #96e1d2;border-radius:12px;',
    },
    'sakura': {
        '_label': '樱花',
        'card': {
            'bg': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #fff8fb,stop:0.54 #fff2f7,stop:1 #ffe8f2)',
            'border': 'rgba(255,170,205,220)',
            'title': '#3a1a2a', 'body': '#4a2835', 'meta': '#9e6a80',
            'box_bg': '#ffffff', 'dark': False,
        },
        'orb': {
            'bg': (255, 246, 250, 245), 'border': (255, 170, 205, 235),
            'wave': (255, 125, 175, 225), 'dot': (235, 120, 180),
            'ring': (255, 145, 160), 'core': (255, 125, 175, 230),
            'core2': (255, 200, 220, 220), 'text': (58, 35, 45, 230),
        },
        'orb_glow': ((255, 255, 255, 112), (255, 215, 230, 58)),
        'input_card_bg': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 rgba(255,255,255,248),stop:1 rgba(255,246,250,242))',
        'input_card_border': 'rgba(255,170,200,235)',
        'input_dot': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #ff8fc8,stop:1 #ffb8d8)',
        'input_text': '#3a1a2a',
        'menu_bg': '#ffeaf4',
        'menu_border': '#f0a0c8',
        'menu_btn_bg': '#ffd0e8',
        'menu_btn_hover': '#ffb8d8',
        'menu_primary': '#d84488',
        'easter_fg': '#3a1a2a',
        'easter_accent': '#ef5c91',
        'chat_header_bg': '#fff8fb',
        'chat_header_border': '#ffd0e5',
        'chat_input_bg': '#fff4f8',
        'accent': '#e05090',
        'preview_qss': 'background:qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #fff8fb,stop:1 #ffe8f2);border:1px solid #ffaacd;border-radius:12px;',
    },
    'sunset': {
        '_label': '日落',
        'card': {
            'bg': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #fffdf5,stop:0.54 #fff8e8,stop:1 #fff0d8)',
            'border': 'rgba(255,185,105,220)',
            'title': '#3a2a10', 'body': '#4a3520', 'meta': '#9e7a45',
            'box_bg': '#ffffff', 'dark': False,
        },
        'orb': {
            'bg': (255, 249, 240, 245), 'border': (255, 185, 105, 235),
            'wave': (255, 165, 80, 225), 'dot': (240, 150, 75),
            'ring': (255, 130, 90), 'core': (255, 145, 70, 230),
            'core2': (255, 215, 120, 220), 'text': (58, 40, 28, 230),
        },
        'orb_glow': ((255, 250, 220, 118), (255, 210, 125, 58)),
        'input_card_bg': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 rgba(255,255,255,248),stop:1 rgba(255,248,235,242))',
        'input_card_border': 'rgba(255,185,100,235)',
        'input_dot': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #ffb040,stop:1 #ffd080)',
        'input_text': '#3a2a10',
        'menu_bg': '#fff0d0',
        'menu_border': '#e8b060',
        'menu_btn_bg': '#ffd898',
        'menu_btn_hover': '#ffc878',
        'menu_primary': '#d07018',
        'easter_fg': '#3a2a10',
        'easter_accent': '#ff9030',
        'chat_header_bg': '#fffdf5',
        'chat_header_border': '#ffd8a0',
        'chat_input_bg': '#fff9ee',
        'accent': '#e07820',
        'preview_qss': 'background:qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #fffdf5,stop:1 #fff0d8);border:1px solid #ffb969;border-radius:12px;',
    },
    'violet': {
        '_label': '紫罗兰',
        'card': {
            'bg': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #fdf8ff,stop:0.54 #f8f0ff,stop:1 #f2e8ff)',
            'border': 'rgba(183,150,255,210)',
            'title': '#2a1840', 'body': '#3c2858', 'meta': '#8a6aaa',
            'box_bg': '#ffffff', 'dark': False,
        },
        'orb': {
            'bg': (248, 244, 255, 245), 'border': (183, 150, 255, 235),
            'wave': (143, 111, 255, 225), 'dot': (155, 105, 255),
            'ring': (132, 115, 255), 'core': (130, 105, 255, 230),
            'core2': (210, 150, 255, 210), 'text': (45, 38, 62, 230),
        },
        'orb_glow': ((255, 255, 255, 98), (225, 205, 255, 52)),
        'input_card_bg': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 rgba(255,255,255,248),stop:1 rgba(248,240,255,242))',
        'input_card_border': 'rgba(183,148,255,235)',
        'input_dot': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #a080ff,stop:1 #c8a8ff)',
        'input_text': '#2a1840',
        'menu_bg': '#ece4ff',
        'menu_border': '#a888e8',
        'menu_btn_bg': '#d8c8ff',
        'menu_btn_hover': '#c8b4ff',
        'menu_primary': '#7030d8',
        'easter_fg': '#2a1840',
        'easter_accent': '#9060e8',
        'chat_header_bg': '#fdf8ff',
        'chat_header_border': '#ddc8ff',
        'chat_input_bg': '#faf5ff',
        'accent': '#7c40e0',
        'preview_qss': 'background:qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #fdf8ff,stop:1 #f2e8ff);border:1px solid #b796ff;border-radius:12px;',
    },
    'dark': {
        '_label': '暗色',
        'card': {
            'bg': 'rgba(36,42,58,238)',
            'border': 'rgba(90,105,145,220)',
            'title': '#f3f6ff', 'body': '#d9e0f2', 'meta': '#9faad0',
            'box_bg': 'rgba(255,255,255,35)', 'dark': True,
        },
        'orb': {
            'bg': (46, 52, 68, 245), 'border': (90, 105, 145, 235),
            'wave': (100, 140, 200, 220), 'dot': (120, 155, 210),
            'ring': (85, 155, 190), 'core': (100, 145, 210, 230),
            'core2': (160, 190, 230, 220), 'text': (220, 228, 248, 230),
        },
        'orb_glow': ((255, 255, 255, 85), (140, 165, 210, 42)),
        'input_card_bg': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 rgba(44,50,66,248),stop:1 rgba(38,44,58,242))',
        'input_card_border': 'rgba(80,95,130,235)',
        'input_dot': 'qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #5888cc,stop:1 #8ab0e0)',
        'input_text': '#dce4f4',
        'menu_bg': 'rgba(40,46,62,248)',
        'menu_border': 'rgba(80,95,130,220)',
        'menu_btn_bg': 'rgba(60,70,92,240)',
        'menu_btn_hover': 'rgba(70,85,115,245)',
        'menu_primary': '#4a88e0',
        'easter_fg': '#dce4f4',
        'easter_accent': '#6a9de8',
        'chat_header_bg': '#2a3042',
        'chat_header_border': '#3a4460',
        'chat_input_bg': '#252e40',
        'accent': '#4a88e0',
        'preview_qss': 'background:#242a3a;border:1px solid #5a6991;border-radius:12px;',
    },
}

# THEME_OPTIONS 控制设置页下拉框的顺序和显示名，不修改此列表不会影响已有主题数据
THEME_OPTIONS = [
    ('aurora', '极光'),
    ('jade', '玉石'),
    ('sakura', '樱花'),
    ('sunset', '日落'),
    ('violet', '紫罗兰'),
    ('dark', '暗色'),
]

DEFAULT_THEME = 'aurora'

# 旧配置键 → 最接近的新主题（用于迁移）
# 历史版本分别用 reply_card_style / voice_orb_style 两个字段控制外观，新版统一为 app_theme；
# 迁移时优先采用 reply_card_style（更显眼），找不到再参考 orb 风格
_LEGACY_REPLY_MAP = {'aurora': 'aurora', 'glass': 'aurora', 'cream': 'sunset', 'mint': 'jade', 'dark': 'dark'}
_LEGACY_ORB_MAP = {'jade': 'jade', 'mint': 'aurora', 'violet': 'violet', 'sakura': 'sakura', 'sunset': 'sunset', 'mono': 'dark'}


def get_theme(name=None):
    """返回主题字典；name 无效时回退到 aurora。

    调用方无需判断 name 是否合法，此函数始终返回完整的主题 dict，
    避免上层代码出现 KeyError 或需要写防御性检查。
    """
    return THEMES.get(name or DEFAULT_THEME, THEMES[DEFAULT_THEME])


def current_theme():
    """返回当前应用配置的主题字典。

    每次调用都从 config 读取最新值，无需重启即可在运行时切换主题。
    """
    return get_theme(config.app_config.get('app_theme', DEFAULT_THEME))


def migrate_legacy_theme():
    """
    将旧的 reply_card_style / voice_orb_style 迁移到 app_theme。

    策略：reply_card_style 优先（它是更显眼的组件），voice_orb_style 作参考。
    已有 app_theme 则不覆盖。
    """
    if config.app_config.get('app_theme'):
        return
    reply_style = config.app_config.get('reply_card_style', '')
    orb_style = config.app_config.get('voice_orb_style', '')
    theme = (_LEGACY_REPLY_MAP.get(reply_style) or _LEGACY_ORB_MAP.get(orb_style) or DEFAULT_THEME)
    config.app_config['app_theme'] = theme
