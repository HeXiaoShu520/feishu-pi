# Third Party Notices

本文列出 MiniPet 当前打包或参考的第三方项目、资源来源和许可状态。

## DyberPet

- Project: DyberPet
- Source: https://github.com/ChaozhongLiu/DyberPet
- License: GPL-3.0
- License copy: [third_party/dyberpet/LICENSE.GPL-3.0.txt](third_party/dyberpet/LICENSE.GPL-3.0.txt)
- Used for: MiniPet 桌宠基础结构、资源格式和桌面宠物交互参考
- Notice: MiniPet 由 MINIPET 简化整合而来，MINIPET 基于 DyberPet 开发。由于 DyberPet 使用 GNU General Public License v3.0，发布 MiniPet 时应保留 DyberPet 来源、版权和 GPL-3.0 许可说明，并按 GPL-3.0 兼容方式分发。

## CyberZen（赛博木鱼）

- Project: CyberZen
- Source: https://github.com/Litt1eQ/cyber-zen
- License: GPL-3.0-only
- License copy: [third_party/cyber-zen/LICENSE.GPL-3.0-only.txt](third_party/cyber-zen/LICENSE.GPL-3.0-only.txt)
- Used for:
  - 木鱼小组件的桌面悬浮交互、功德飘字和点击反馈参考
  - 当前打包的木鱼图片资源
- Bundled files currently derived from CyberZen:
  - `res/items/wooden_fish/muyu.png`
  - `res/items/wooden_fish/hammer.png`
- Compliance note:
  - 由于 CyberZen 使用 GPL-3.0-only，如果继续打包上述资源并对外发布，需要遵守 GPL-3.0-only 的要求。
  - 若未来希望保持更宽松的项目许可，应将上述资源替换为自制资源或明确宽松授权 / CC0 资源，并更新本文档。

## Electronic Wooden Fish

- Project: Electronic Wooden Fish
- Source: https://github.com/xiwang-online/Electronic-Wooden-Fish
- License: 按随项目资源一并保留来源与第三方声明处理
- Used for:
  - 木鱼音效体验参考
  - 当前打包的木鱼敲击音效转换文件
- Bundled files currently derived from Electronic Wooden Fish:
  - Source file: `Electronic-Wooden-Fish-main/src/assets/1.mp3`
  - Bundled/converted files:
    - `res/sounds/WoodenFish.mp3`
    - `res/sounds/WoodenFish.wav`
- Compliance note:
  - 当前按第三方资源继续打包，并在本文档中保留来源、用途和派生文件列表。
  - 如果后续更换为自制或其他授权音效，应同步更新本文档。

## dice3d

- Project: dice3d
- Source: https://github.com/esnya/dice3d
- License: MIT License
- Used for:
  - 骰子 3D 滚动交互节奏参考
  - 骰子滚动音效
- Bundled files currently derived from dice3d:
  - Source file: `third_party/easter_refs/dice3d/dist/nc93322.mp3`
  - Bundled file: `res/sounds/easter/dice3d_roll.mp3`
- Upstream sound notice from dice3d README:
  - `[サイコロ] 1D6 [SE]`
  - http://commons.nicovideo.jp/material/nc93322

## Magic 8 Ball references

### deanwiles/Magic-8-Ball

- Project: Magic-8-Ball
- Source: https://github.com/deanwiles/Magic-8-Ball
- License: BSD 3-Clause License
- License copy: [third_party/easter_refs/Magic-8-Ball/LICENSE](third_party/easter_refs/Magic-8-Ball/LICENSE)
- Used for:
  - 仅作为本地视觉方向误参考；已确认不适合“神奇海螺”功能。
- Bundled files: none
- Compliance note:
  - 不再复制或打包 Magic 8 Ball 图片 / GIF 资源。

### lonemortensen/magic8ball

- Project: magic8ball
- Source: https://github.com/lonemortensen/magic8ball
- Used for:
  - 魔法海螺“输入问题 → 等待 → 随机回答”的交互节奏参考
- Bundled files: none

### marcusholmgren/magic_eight_ball

- Project: magic_eight_ball
- Source: https://github.com/marcusholmgren/magic_eight_ball
- License: 未在仓库根目录发现 LICENSE 文件
- Used for:
  - Svelte 版 Magic 8 Ball 的 UI / 交互参考
- Bundled files: none
- Compliance note:
  - 因未发现明确许可证，仅作为本地开发参考；不要复制其代码或资源进入正式发布包，除非后续确认授权。

## rpg-dice-roller

- Project: rpg-dice-roller
- Source: https://github.com/dice-roller/rpg-dice-roller
- License: MIT License
- License copy: [third_party/easter_refs/rpg-dice-roller/licence.txt](third_party/easter_refs/rpg-dice-roller/licence.txt)
- Used for:
  - 骰子表达式与规则系统参考
- Bundled files: none

## fortunejs/fortune

- Project: fortune
- Source: https://github.com/fortunejs/fortune
- License copy: [third_party/easter_refs/fortune/LICENSE](third_party/easter_refs/fortune/LICENSE)
- Used for:
  - 数据/API 项目结构调研；当前确认不适合作为中文求签签文库
- Bundled files: none

## General policy

- 只参考产品交互或实现思路：README 致谢即可。
- 复制或改编代码、图片、音频、字体等资源：必须保留来源、许可证文本，并遵守原许可证。
- 无明确 LICENSE 的第三方资源：仅可作为本地临时开发参考；正式发布前应替换或取得授权。
