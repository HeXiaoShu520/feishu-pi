# 素材开发文档

本文档说明 MiniPet 当前支持的角色素材格式。旧版 DyberPet / MINIPET 中的商店、物品、好感度、通知音效、对话物品、迷你宠物等系统当前没有在 MiniPet 中接入，本文件不再保留这些配置说明。

## 目录

- [角色目录结构](#角色目录结构)
- [动画帧命名](#动画帧命名)
- [pet_conf.json](#pet_confjson)
- [act_conf.json](#act_confjson)
- [动作播放规则](#动作播放规则)
- [头像和展示资源](#头像和展示资源)
- [开发流程](#开发流程)
- [常见问题](#常见问题)

## 角色目录结构

角色放在：

```text
minipet/res/role/<角色名>/
```

一个最小可用角色目录：

```text
<角色名>/
├── pet_conf.json
├── act_conf.json
└── action/
    ├── stand_0.png
    ├── stand_1.png
    ├── drag_0.png
    └── fall_0.png
```

推荐可选资源：

```text
<角色名>/
├── info/
│   └── pfp.png          # 角色头像，可用于设置中的宠物头像
└── action/
    ├── left_0.png
    ├── right_0.png
    ├── patpat_0.png
    └── sleep_0.png
```

注意：

- 文件名建议使用英文、数字、下划线或短横线，避免不同系统解压后乱码。
- 动画图片建议使用透明背景 PNG。
- `res/role/sys` 是系统目录，不会作为角色加载。
- 角色目录必须包含 `pet_conf.json` 才会出现在角色列表中。

## 动画帧命名

每个动作由一组 PNG 帧组成，放在角色的 `action/` 目录下。

命名规则：

```text
<图片前缀>_0.png
<图片前缀>_1.png
<图片前缀>_2.png
...
```

例如：

```text
action/stand_0.png
action/stand_1.png
action/stand_2.png
```

也支持单帧图片：

```text
action/stand.png
```

加载顺序按数字后缀从小到大排序。建议所有帧保持相同画布大小、相同角色比例和相同底部中心点。

## pet_conf.json

`pet_conf.json` 定义角色尺寸、默认动作和随机动作组合。

最小示例：

```json
{
  "width": 128,
  "height": 128,
  "scale": 1.0,
  "interact_speed": 0.02,
  "default": "stand",
  "drag": "drag",
  "fall": "fall",
  "prefall": "fall",
  "on_floor": "stand",
  "patpat": "patpat",
  "random_act": [
    {
      "name": "站立",
      "act_list": ["stand"],
      "act_prob": 1.0
    }
  ]
}
```

字段说明：

| 字段 | 类型 | 说明 |
|:--|:--|:--|
| `width` | number | 角色画布宽度，会乘以 `scale` 后作为窗口宽度 |
| `height` | number | 角色画布高度，会乘以 `scale` 后作为窗口高度 |
| `scale` | number | 显示比例，也会影响移动距离和 anchor |
| `refresh` | number | 保留字段，当前动画播放主要使用动作里的 `frame_refresh` |
| `interact_speed` | number | 交互刷新间隔，单位秒 |
| `default` | string | 默认待机动作，必须能在 `act_conf.json` 中找到 |
| `drag` | string | 鼠标拖拽时的动作 |
| `fall` | string | 掉落时的动作 |
| `prefall` | string | 松手后进入掉落前的动作，缺省时使用 `fall` |
| `on_floor` | string | 落地瞬间动作，缺省时使用 `default` |
| `patpat` | string/object | 点击宠物时播放的动作 |
| `random_act` | array | 空闲时随机播放的动作组合 |
| `accessory_act` | array | 带附加组件的动作组合，可选 |

### patpat 写法

只有一个点击动作：

```json
{
  "patpat": "patpat"
}
```

按 0-3 档配置不同点击动作：

```json
{
  "patpat": {
    "0": "patpat_low",
    "1": "patpat_mid",
    "2": "patpat_high",
    "3": "patpat_high"
  }
}
```

当前 MiniPet 不维护旧版饱食度系统，但代码仍兼容这种写法；通常写一个字符串即可。

### random_act 写法

```json
{
  "random_act": [
    {
      "name": "左右走动",
      "act_list": ["left_walk", "right_walk", "stand"],
      "act_prob": 0.2
    },
    {
      "name": "站立",
      "act_list": ["stand"],
      "act_prob": 1.0
    }
  ]
}
```

说明：

- `act_list` 中的动作名必须存在于 `act_conf.json`。
- `act_prob` 是相对权重，不要求总和为 1。
- `name` 会用于动作菜单显示。
- 旧版 `act_type` 当前不会参与 MiniPet 的随机概率计算，可不写。

### accessory_act 写法

`accessory_act` 用于动作播放时叠加额外组件动画。

```json
{
  "accessory_act": [
    {
      "name": "特效动作",
      "act_list": ["skill"],
      "acc_list": ["effect"],
      "anchor": [40, -20]
    }
  ]
}
```

说明：

- `act_list` 是主角色动作。
- `acc_list` 是附加组件动作。
- `anchor` 是附加组件相对位置，会乘以 `scale`。
- 当前 MiniPet 只读取 `name`、`act_list`、`acc_list`、`anchor`。

## act_conf.json

`act_conf.json` 定义每个动作如何读取图片、播放几次、是否移动。

示例：

```json
{
  "stand": {
    "images": "stand",
    "act_num": 1,
    "frame_refresh": 0.18
  },
  "drag": {
    "images": "drag",
    "act_num": 1,
    "frame_refresh": 0.18
  },
  "fall": {
    "images": "fall",
    "act_num": 1,
    "frame_refresh": 0.12
  },
  "left_walk": {
    "images": "left",
    "act_num": 4,
    "direction": "left",
    "frame_move": 2.0,
    "frame_refresh": 0.12
  },
  "right_walk": {
    "images": "right",
    "act_num": 4,
    "direction": "right",
    "frame_move": 2.0,
    "frame_refresh": 0.12
  },
  "sleep": {
    "images": "sleep",
    "act_num": 3,
    "anchor": [0, 20],
    "frame_refresh": 0.2
  }
}
```

字段说明：

| 字段 | 类型 | 默认值 | 说明 |
|:--|:--|:--|:--|
| `images` | string | 动作名 | 图片前缀，读取 `action/<images>_*.png` 或 `action/<images>.png` |
| `act_num` | integer | `1` | 动作帧序列重复播放次数 |
| `direction` | string/null | `null` | 移动方向，可为 `left`、`right`、`up`、`down` |
| `frame_move` | number | `0` | 每帧移动距离，会乘以 `scale` |
| `frame_refresh` | number | `0.5` | 每帧停留时间，单位秒 |
| `anchor` | array | `[0, 0]` | 当前帧相对窗口的偏移，会乘以 `scale` |

## 动作播放规则

MiniPet 的动画播放逻辑很简单：

1. 启动时读取当前角色的 `pet_conf.json` 和 `act_conf.json`。
2. 根据 `act_conf.json` 加载 `action/` 里的 PNG 帧。
3. 空闲时从 `random_act` 中按 `act_prob` 随机选择动作组合播放。
4. 用户拖拽、掉落、点击宠物时会播放对应动作。
5. 动作设置了 `direction` 和 `frame_move` 时，窗口会跟随每一帧移动。

如果 `random_act` 为空，程序会回退播放 `default` 动作。建议至少配置一个默认待机动作。

## 头像和展示资源

角色可以提供头像：

```text
res/role/<角色名>/info/pfp.png
```

当前 MiniPet 的聊天、语音聊天和豆包通话头像主要由“基础设置”里的头像路径控制。你可以在设置中选择角色头像文件，设置页会立即显示图片预览。

推荐头像：

- PNG / JPG / SVG 均可。
- 建议正方形。
- 透明背景或浅色背景都可以。

## 开发流程

1. 在 `minipet/res/role/` 下新建英文目录名，例如 `ChrisKitty`。
2. 创建 `action/` 目录，放入透明 PNG 动画帧。
3. 编写 `act_conf.json`，定义每个动作读取哪些图片、播放速度和移动参数。
4. 编写 `pet_conf.json`，指定默认动作、拖拽动作、掉落动作和随机动作。
5. 启动 MiniPet，在设置中切换默认宠物进行测试。
6. 检查拖拽、点击、掉落、随机动作和缩放是否自然。

## 常见问题

### 角色不出现在列表里

检查：

- 目录是否在 `minipet/res/role/` 下。
- 是否有 `pet_conf.json`。
- 目录是否误命名为 `sys`。

### 启动时报 Action images not found

说明某个动作找不到图片。检查：

- `act_conf.json` 里的 `images` 是否和图片前缀一致。
- 图片是否放在 `action/` 目录下。
- 是否至少有 `前缀_0.png` 或 `前缀.png`。

### 动画抖动或跳位置

通常是每一帧画布大小、角色底部中心点或 `anchor` 不一致。建议：

- 所有帧使用相同画布大小。
- 所有帧角色脚底或底部中心保持在同一位置。
- 只在确实需要时使用 `anchor`。

### 移动太快或太慢

调整 `frame_move` 和 `frame_refresh`：

- `frame_move` 越大，每帧移动越远。
- `frame_refresh` 越小，帧刷新越快。
- 角色整体缩放 `scale` 也会影响移动距离。
