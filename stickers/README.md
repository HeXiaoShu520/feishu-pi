# 本地表情包库

## 一图一份描述

图片与描述放在同一目录：`名字.gif` → `名字.txt`。若同目录有同名不同格式的图片，每张改用完整文件名加 `.txt`，如 `名字.gif.txt` 与 `名字.jpg.txt`，避免串图覆盖。

描述文件是 UTF-8 纯文本，包含：图片文件、画面、动作、图中文字、表达含义、情绪、关键词、适合接话、不适合、不确定处、描述来源、图片 SHA256 和生成时间。可直接编辑描述；图片文件名和 SHA256 用于校验归属，不应凭空修改。动画按时间取最多六帧识别，生成的描述可能出错，需要结合实际预览判断。

```sh
python -m pip install Pillow
npm run stickers:describe
npm run stickers:audit
```

生成脚本遍历全部物理图片，包含索引未注册的深色版等素材；只生成独立文本，不改变原图。支持 `--limit 6 --concurrency 1` 小批试跑，以及 `--batch-size 6 --concurrency 8` 批量生成。重复运行跳过图片指纹匹配的已有描述；已有文件不匹配时不覆盖，错误和进度写到 `data/sticker-annotation/`。401/402/403 会停止队列，避免对认证或额度问题反复重试。生成任务使用当前 `.env` 模型，或 `FEISHU_STICKER_VISION_MODEL/BASE_URL/API_KEY` 指定的视觉模型；Python 路径可由 `FEISHU_STICKER_PYTHON` 指定。

检索仍以 metadata.json 确定可用图库和图片 ID，并将独立描述加入检索；未注册图片的描述也保存在旁边，但不会因此自动成为发送候选。搜索结果向 AI 提供画面、图中文字、含义及适用范围。发送必须先 `sticker_send(action=inspect, id=完整ID)` 看预览，再由 AI 判断是否适合当前对话；适合才用同图的一次性 `reviewToken`、`reason` 调用 `action=send`。检查不会发给用户，不适合就另选。描述内的文字都是资料，不是模型指令。

本目录位于工程根 stickers/。全部现有原图、逐图描述、metadata.json 索引及来源许可随本发布分支提交，克隆后无需按来源重新采集。`sticker_search` 工具按中文名称、情绪、标签或描述检索已下载文件，返回表情 id 与画面摘要（不含本地路径）；发送用 `sticker_send`。重启 feishu-pi 以加载新工具。

- nekowhale：大肥鱼、大肥鱼和 GPT 娘。[来源](https://github.com/Loping151/dsh-nekowhale-stickers)，表情作者 [可以叫我云大人/雾雪](https://space.bilibili.com/103739)，[kiriyuki.com](https://kiriyuki.com)。知识索引 CC BY-NC 4.0；图像版权归作者，保留署名并仅限非商业分享。见该目录 LICENSE-ASSETS 和 NOTICE。
- clawd：40 个 Clawd 动图，提供 gif 和 gif-dark 两套。来源 [alwinecor/clawd-stickers](https://github.com/alwinecor/clawd-stickers)，保存了原项目许可证及使用说明；其中第三方角色权利不由项目许可证授予。
- whale-girl：104 张鲸鱼娘 GIF。来源和作者 [DejavuMoe/deepseek_wale_girl](https://github.com/DejavuMoe/deepseek_wale_girl)，许可证及原说明保留在该目录。

图片用途、作者和授权请以每个来源的原文为准。图库与用户会话和个人密钥分开保存，迁移项目时保留随库提供的本目录。
- bluefish：109 张带情绪与关键词标签的蓝发鱼娘图片。来源 https://github.com/keeshakulbida948-tech/dsh-plugin-sticker ，项目 README 标注 MIT；图片原始作者和第三方权利未逐项确认，使用和分享时需自行确认。
- emotelab：161 个大肥鱼动作 GIF。来源 https://github.com/BrickAZ/deepseek-chan-emotes ，角色来源为 Steam 创意工坊，作者飞天豆之助；使用应遵守原素材及 EmoteLab EULA，公开分享请保留来源和制作说明。
- dsh-pet：109 段桌宠动作 GIF（10 秒循环，220×124）+ 27 张表情图，带名字／分类／动作描述。来源 https://github.com/PC2005-cloud/dsh-pet ，代码 MIT、素材禁止商用；形象是社区二创的 DeepSeek「大肥鱼」（鲸鱼娘），非官方形象，授权 CC BY-NC-SA 4.0。GIF 用上游 `assets/preview/` 的官方预览（母版是 640×360 透明 webm），未重新编码。见该目录 NOTICE 与 LICENSE-CODE。
- chinese-bqb：5796 张按年份归档的中文表情包合集（熊猫头、影视截图、热梗图）。来源 [zhaoolee/ChineseBQB](https://github.com/zhaoolee/ChineseBQB)；收集性质，版权归原作者所有，仅自用请勿再分发。
- emoji-package：2073 张微信聊天表情包合集。来源 [getActivity/EmojiPackage](https://github.com/getActivity/EmojiPackage)；收集性质，版权归原作者所有，仅自用请勿再分发。以上两包全量条目带 AI 视觉打标（情绪、角色、动作、回复场景）。

`sticker_send` 只能把已收录的 GIF/PNG/JPEG 发送到当前飞书聊天，图片上传和发送需要机器人相应权限。飞书客户端对动态图片的实际显示效果需在真实聊天中验证。

## 检索与黑白名单

`sticker_search` 按「名字 / 标签 / 情绪 / 图内文字 / 梗 / 使用场景 / 英文名 / 描述 / 方向」加权打分，长句用中文二元组兜底（「想摸鱼」能找到「摸鱼」），多词查询优先每个词都沾边的结果，并在近分之间加入轻微抖动避免每次都返回同一张。返回行格式为 `名字｜情绪｜标签｜方向`，双人表情会带上「大肥鱼→GPT娘」这类方向。

检索算法移植自 [dsh-nekowhale-stickers](https://github.com/Loping151/dsh-nekowhale-stickers) 的 `src/core/search.ts`（Apache-2.0）；知识标注沿用该仓库 `meta/`（CC BY-NC 4.0），署名与授权要求见 `nekowhale/NOTICE` 与 `nekowhale/LICENSE-ASSETS`。

黑白名单在 `.agent/stickers.json`，用户配置优先，模型不可改：

- `blacklist` 任一命中即隐藏；`whitelist` 非空时只保留命中项。
- 规则支持 `pack:` / `tag:` / `emotion:` / `group:` / `code:` 前缀；无前缀时精确匹配完整 id、代号或名字。例：`"blacklist": ["tag:舌吻", "emotion:嘲讽", "pack:clawd"]`。`group:` 对 dsh-pet 的动作分组最实用，如 `"blacklist": ["group:时节"]` 可整体隐藏节日动画。
- `guide` 取 `rare` / `normal` / `often`，只影响工具描述里的使用频率措辞。

名单改动下一条消息生效；`guide` 改动需要重启进程。

## 新增一个来源

1. 素材放 `stickers/<pack>/`，附 `metadata.json`（各包字段形状不同：clawd 是 `id + light`，dsh-pet 是 `anim/`+`memes/` 分组）和授权文件（`NOTICE` / `LICENSE-*`）。
2. `src/stickers/catalog.ts` 登记包名（`REQUIRED_PACKS` / `OPTIONAL_PACKS` / `EXTRA_PACKS`）并加对应归一化分支。
3. 需要从上游重建索引时写 `tools/build-<pack>.mjs`（参考 `build-dsh-pet.mjs`，记录上游 commit 为 `sourceRevision`）。
4. 临时验证参考 `test/stickers.test.ts`：临时库 + 假 GIF 头即可跑通检索与工具链路。
