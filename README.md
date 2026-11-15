# feishu-pi

部署在本人电脑上的个人 Agent，基于 Pi AgentSession。飞书提供远程交互入口；管理员可使用浏览器、后台任务和 MCP 等执行能力，普通用户可以私聊、在群里 @ 机器人聊天和使用表情包。

这是基于 Pi AgentSession 的个人飞书助手。

## 开始使用

本发布分支自带默认人格、配置模板、clawd 和 whale-girl 两套表情原图及逐图描述，不需要重新识图。仍需使用者配置自己的飞书应用和模型接口，仓库不包含作者账号或聊天数据。

建议 Windows、最新 Node.js 22.x 或更新版本、Python 3.11+、Git。模型需支持图片输入与工具调用。浏览器默认使用本机 Edge，也可配置 Chrome。

```sh
git clone --branch release/ready-to-run-20261116 --single-branch https://github.com/HeXiaoShu520/feishu-pi.git
cd feishu-pi
npm ci
python -m pip install -r requirements-stickers.txt
npm run setup
```

向导配置飞书应用。在生成的 `.env` 中填写：

```dotenv
FEISHU_PI_OWNER=ou_你的飞书OpenID
FEISHU_PI_MODEL_NAME=你的模型名称
FEISHU_PI_MODEL_BASE_URL=你的模型接口地址
FEISHU_PI_MODEL_API_KEY=你的模型密钥
```

模型名称与接口地址必须匹配所用服务，不能照抄其他人的配置。保留向导写入的 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`；管理员 Open ID 使用当前机器人应用对应的用户 ID。

然后运行：

```sh
npm run doctor
npm start
```

`doctor` 检查依赖、图片资源与配置是否填写，不输出密钥、不发消息。它不验证远端接口鉴权、额度或飞书发布状态。只检查安装环境可运行 `npm run doctor -- --no-config`。

其他人可以私聊或在群里 @ 机器人聊天，但没有本机、浏览器或管理员账户工具权限。本人尚未配置或无法识别时，服务停止启动。首次启动后，先私聊发“你好”，再用一张普通图片验证视觉。

飞书应用需要启用机器人、长连接和 `im.message.receive_v1`、`card.action.trigger`。向导提供预置权限；应用后台提示待发布时，需要发布才能生效。Open ID 可以通过飞书开发者后台的用户 ID 查询工具获取；使用本机器人应用对应的 ID。

完整安装与资源范围见 [首次运行](docs/quick-start.md)。

## 个人能力

| 能力 | 实现 |
|---|---|
| 权限 | `deny` 硬拒绝；`ask` 审核模型；`allow` 确定性放行；未匹配默认拒绝 |
| 浏览器 | 按需启动 Playwright CLI，持久化独立登录状态，页面快照、点击、输入、上传、截图和人工接管 |
| 后台任务 | 启动、状态、日志、取消、超时、并发限制、持久化记录和完成通知 |
| MCP | 按需连接 stdio / Streamable HTTP / 显式 legacy SSE；工具发现与调用、资源和提示读取 |
| 飞书 | 文本、图片、语音、附件、引用、CardKit 2.0 流式回复、人物提及与本人授权 |
| 定时任务 | 一次性、固定间隔、cron、时区、启停和手动执行 |
| 扩展 | Markdown 技能，TS/JS/Python 工具和 Pi 扩展 |

浏览器和 MCP 未使用时不启动。记忆默认开启，用户画像由 AI 必要时更新并按人共用，助手自我视角仍按聊天范围整理；`FEISHU_PI_AGENT_MEMORY=0` 可关闭。群聊主动发言默认关闭，需配置指定群；显式创建的定时任务按设定运行。

## 表情包来源

每张图片旁保存独立同名描述文件，例如 `嘿嘿.gif` 对应 `嘿嘿.txt`；同目录存在同名不同格式的图片时，用 `名字.gif.txt`、`名字.jpg.txt` 分开。内容包含画面、动作、图中文字、表达含义、情绪、关键词、适合接话、不适合场景和不确定处。描述来自实际图像的模型识别，动图按时间采样最多六帧，可能遗漏瞬间或误读文字，不代表绝对准确。

`sticker_search` 使用这些描述筛选候选。`sticker_send` 先以 `action=inspect` 返回实际图片预览和描述，此时不上传、不发送；模型结合当前聊天自行判断，适合才带一次性 `reviewToken` 和接话理由调用 `action=send`，不适合继续换选或只回文字。只接受完整表情 ID，不能再用“开心”等情绪词直接随机发送。凭证绑定会话、图片和描述，五分钟失效；修改图片或描述后需要重新检查。流程保证先提供看图机会，语境判断仍可能出错。

`npm run stickers:describe` 为磁盘上全部图片生成描述；已有且图片指纹匹配的文件跳过，已有不匹配的文件保留并报告待复核。`npm run stickers:audit` 核对覆盖率和图片指纹。生成默认使用已配置的模型接口；可通过 `FEISHU_STICKER_VISION_*` 单独指定视觉模型，进度及失败清单在 `data/sticker-annotation/`。描述文件随 Git 保存，大包原图仍需另行备份。工具代码改动需重启，描述内容约五秒刷新缓存。

成功发送的表情名称、描述和时间按聊天隔离保存在 `data/sticker-history/`，每个聊天保留最近 30 条；最近发送的表情在检索中降权，明确指定的表情仍可重复发送。最近 5 条描述可供模型参考，但不代表模型看过原图。记录写入失败不代表发送失败。

搜索工具支持按思考、工作、等待、成功、失败、休息、打招呼等场景查找 dsh-pet 动作；是否调用搜索及发送仍由模型结合实际对话判断，不会每次任务状态变化都自动发图。状态图需以真实任务结果为依据，严肃话题可不发。场景搜索同样遵守表情黑白名单和当前聊天的近期去重。

本地表情库位于工程根 `stickers/`（不再放在 `data/` 下）。8 套组的 `metadata.json` 索引与许可文件入库 Git；图片仅 clawd、whale-girl 两个小套组随库提交，其余大包留本地，换机器后按来源重新采集、配合入库索引即可重建。`sticker_search` 按名称、情绪和描述检索（加权字段 + 中文二元组兜底，近期发过的自动降权避免连发重复），`sticker_send` 将所选表情发送到当前飞书会话；黑白名单在 `.agent/stickers.json`，用户配置优先、模型不可改。各套素材的作者、来源及授权以原项目和图库目录中的说明为准：

斗图还可按自己的回应方向检索（反击、闪避、认输等），选图后须预览再发送。**飞书收藏表情消息不支持通过公开消息资源接口下载，机器人不能据占位符理解画面**；要让它看图接招，请以普通图片消息发送。`npm run stickers:eval -- --live` 可在本地模拟发送并验证真实模型的检索和预览流程。

| 表情包 | 来源与署名 |
|---|---|
| 大肥鱼 / GPT 娘（nekowhale） | [dsh-nekowhale-stickers](https://github.com/Loping151/dsh-nekowhale-stickers)；表情作者 [可以叫我云大人 / 雾雪](https://space.bilibili.com/103739)，由 [kiriyuki.com](https://kiriyuki.com) 制作；角色设计来自 ZipZipPipe 和上善无形。知识数据为 CC BY-NC 4.0，图片版权归作者，非商业分享须保留署名。 |
| Clawd Dev Life（clawd） | [alwinecor/clawd-stickers](https://github.com/alwinecor/clawd-stickers)，40 个表情各有浅色和深色版。项目贡献内容按其 LICENSE 授权；Clawd 等第三方角色权利不包含在该授权中。 |
| DeepSeek 鲸鱼娘（whale-girl） | [DejavuMoe/deepseek_wale_girl](https://github.com/DejavuMoe/deepseek_wale_girl)，作者 Dejavu Moe；104 张动态表情。 |
| 蓝发鱼娘（bluefish） | [keeshakulbida948-tech/dsh-plugin-sticker](https://github.com/keeshakulbida948-tech/dsh-plugin-sticker)，109 张图片；原项目 README 标注 MIT，图片原作者及第三方权利未逐项确认。 |
| 大肥鱼动作动图（emotelab） | [BrickAZ/deepseek-chan-emotes](https://github.com/BrickAZ/deepseek-chan-emotes)，角色来源为 Steam 创意工坊“蓝色大肥鱼”，作者飞天豆之助；动图由 EmoteLab 导出，使用须遵守原素材授权及 EmoteLab EULA。 |
| 桌宠动作库（dsh-pet） | [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)；109 段 10 秒动作 GIF（上游 `assets/preview/` 官方预览，母版为 640×360 透明 webm）与 27 张表情图。代码 MIT，素材禁止商用；宠物形象为社区二创的 DeepSeek「大肥鱼」（非官方），授权 CC BY-NC-SA 4.0。 |
| 中文表情包合集（chinese-bqb） | [zhaoolee/ChineseBQB](https://github.com/zhaoolee/ChineseBQB)，5796 张，按年份归档的中文表情包合集；收集性质，版权归原作者所有，仅自用请勿再分发。 |
| 微信表情包合集（emoji-package） | [getActivity/EmojiPackage](https://github.com/getActivity/EmojiPackage)，2073 张；收集性质，版权归原作者所有，仅自用请勿再分发。 |
| 大肥鱼角色表情（dafeiyu） | [diwer/ai-biaoqingbao](https://github.com/diwer/ai-biaoqingbao)，100 张中文 GIF，蓝发鲸鱼娘二创；AI 辅助二创，角色许可边界未完全明确，仅自用、不再分发，来源与许可见 `stickers/dafeiyu/NOTICE.txt`。 |

来源说明和许可文件也保留在对应图库目录中；大包图片不入库，迁移或备份时需单独保存 `stickers/` 下未随库提交的套组目录。

## 人格与回复形态

当前人格为大肥鱼，定义在 `.agent/SYSTEM.md`。每次启动会保存一份人格快照；`npm run persona -- list` 查看版本，`npm run persona -- restore <版本ID>` 恢复并备份恢复前版本，重启后生效。旧版小月人格也已保存到版本目录。

人格与聊天连续性分开：稳定人格在 `.agent/SYSTEM.md`，有用户原话依据的偏好、反馈、事实和经历写入 `data/agent-memory/v2/`，用户画像按用户 ID 跨私聊和群共用，助手自我视角仍按聊天范围隔离。每轮只选择少量相关条目，不写进会话历史。旧的自我记忆和人格成长层保留但停止读取，不再把临场台词总结成以后必须表演的套路。`FEISHU_PI_AGENT_MEMORY=0` 关闭事实记忆；旧 `FEISHU_PI_PERSONA_GROWTH*` 配置已退役。`AGENTS.md` 等工程文档不进入运行时提示。

设计、参考项目与验收方式见 [人格与对话设计](docs/personality-design.md)。`npm run persona:eval` 列出对话评测；加 `-- --live` 使用本机模型生成实际回复，结果写到 `data/persona-evals/`，不发送飞书消息。

大肥鱼也可保留交流中形成的具体兴趣、暂定看法与未完问题，作为分域记忆里的 `subject: self` 条目。它们需要同轮双方原话作依据，修改已有看法需有明确的修正理由；不会自动改写核心人格，也不会全局传播私聊内容。不是情绪值或固定台词成长。真实模型的自主选题与表达仍需实际对话检验。

后续预留方案：[群聊旁听与成员印象](docs/group-impressions.md)，用于理解群聊现场、记录群内共同事件并形成有证据的逐人印象；当前仅有设计文档，尚未实现或启用。

回复形态分两档：短闲聊拆成 1~3 条普通文本消息，首条直接发送，后续气泡之间短暂停顿；代码、表格、长文和需要嵌入图片的回复才走 CardKit 卡片。回复文字默认允许 emoji，`FEISHU_PI_REPLY_EMOJI=0` 可关闭并在发送前剥离。

其他飞书用户可以私聊大肥鱼，也可以在群里 @ 她聊天；群聊与私聊、不同成员之间互相隔离。普通群里不再只响应 @：未 @ 时按潜水策略，被叫名字、像在提问或有人发图时低概率接一句，每群每小时最多 3 次、每次后冷却 10 分钟、深夜不主动；话题群仍只响应 @。`FEISHU_PI_GROUP_CHIME=0` 可关闭主动接话。

群聊主动发言默认关闭。设置 `FEISHU_PI_PROACTIVE=1`，并用 `FEISHU_PI_ACTIVE_CHATS` 指定群（在群里 @ 机器人发 `/chatid` 获取 ID）。开启后，群安静 45 分钟才会考虑开口，结合最近群聊生成一句；两次之间冷却 3 小时、每群每天最多 2 次、深夜不主动，没有自然想说的就跳过。普通用户可使用表情包搜索和发送，不注册本机文件、命令、屏幕控制、浏览器或管理员账户工具；管理指令仅管理员可用。

B 站互动记录另存于 `data/bilibili/interactions.jsonl`；`bili_person` 按 UID 查实际回复过的人及往来记录，读取评论时会带出与该用户的近期互动和已保存的事实。模型可以通过 `bili_remember_person` 保存有已回复评论为依据的人物事实，来源记录在 `data/bilibili/person-facts.jsonl`；旧记录若没有 UID 或对方原文，无法补造。此功能依赖模型主动调用，尚未实现自动过时更新或遗忘评分。

## B 站

管理员可通过 MCP 搜索视频，`bili_explore` 按关键词搜索未读视频，`bili_watch` 一次读取视频资料、字幕和评论并记录成功读取的视频；`bili_check_replies` 查看回复通知并标记已回复项。登录后可按权限流程评论。各项读取可能单独失败，记录不代表看过视频画面。实现基于 [adoresever/bilibili-mcp](https://github.com/adoresever/bilibili-mcp)，保留其 MIT 许可证，源码位于 `tools/bilibili-mcp/`。

自动化借鉴 [Aurabot](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq) 的定时浏览和回复流程，是可选服务：`.env` 中 `FEISHU_BILI_AUTO_AVAILABLE=false`（默认）时不加载服务或启动循环；改为 `true` 并重启后，登录 B 站并在管理员飞书私聊中发送 `/bili-auto on` 启用，`/bili-auto status` 查状态，`/bili-auto run` 立即请求运行一轮，`/bili-auto off` 停用。关闭配置开关不会删除 `data/bilibili/automation.json` 中的状态；之后重新加载服务时，若该状态仍为启用，会自动恢复运行。若不希望恢复，先在服务可用时发送 `/bili-auto off`。开启后每 4 小时探索一轮，每 20 分钟检查评论回复；模型根据大肥鱼人格、兴趣和实际资料决定评论或沉默，每天最多成功发表评论 2 条、回复 5 条。遇到登录失效、验证码、风控或频率限制会暂停当天；登录修复后可重新发送 `on`，风控或限频暂停当天不解除。发送前持久化去重记录，网络结果不明时不自动重试。每次 MCP 调用仍遵循 `.agent/permissions.json`；如审核模型要求本人确认，自动化会等待授权或在拒绝/超时后停止本轮，因此不能保证无需人工干预。不会自动私信、发动态或上传视频。普通的手动 B 站 MCP 工具不依赖此开关。

如还希望大肥鱼向管理员飞书私聊分享浏览到的视频，在上述自动化启用的基础上设置 `FEISHU_BILI_SHARE_AVAILABLE=true` 并重启（默认关闭）。模型会决定分享或跳过；每天最多一次，北京时间 23:00 至次日 08:00 不发送，同一视频不会重复分享。发送前记录尝试，结果不明确时不自动重试。最近五分钟有聊天活动时暂缓分享；只保留一个待分享候选，新的候选可覆盖旧的，超过两小时自动过期；禁用自动化会清除候选。活动时间仅保存在进程中，重启后不保留。

在 Windows 项目目录下安装：

```powershell
python -m venv data\bilibili\venv
.\data\bilibili\venv\Scripts\python.exe -m pip install -r tools\bilibili-mcp\requirements-lock.txt
```

发布评论前，在本机终端运行以下命令，用 B 站 App 扫码登录：

```powershell
.\data\bilibili\venv\Scripts\python.exe tools\bilibili-mcp\bili_login.py
```

登录凭证保存在本机 `data/bilibili/credential.json`，该目录不提交到 Git。通过 `mcp` 调用搜索或评论均受项目权限策略约束；公开评论需要通过当前审核流程。视频搜索、字幕或评论不代表完整观看了视频。

## 权限配置

配置文件：`.agent/permissions.json`。

```json
{
  "deny": ["Read(**/.env*)", "Bash(**.env**)"],
  "ask": ["Bash(*)", "Tools(browser:click)", "Tools(mcp__*)"],
  "allow": ["Read(**)", "Tools(browser)", "Tools(mcp)"]
}
```

顺序为 `deny → 高风险本人确认 → ask → allow → 默认拒绝`。`ask` 优先于 `allow`，所以 `ask: Bash(*)` 表示所有 Bash 调用都审核。默认文件采用这个行为；想让特定命令直接通过，应缩小 `ask` 的范围，并在 `allow` 中列出这些命令。

`FEISHU_GUARD_BASE_URL / FEISHU_GUARD_MODELS / FEISHU_GUARD_API_KEY` 配置 OpenAI 兼容审核接口。未配置、失败或超时回退本人确认。审核结论可以放行、请求本人确认或拒绝；模型和确认卡都不能覆盖 `deny`。权限文件按 mtime 重载，系统提示和技能修改后需重启。

规则约束工具调用参数，不能替代操作系统沙箱。普通 shell 和自定义扩展能执行代码，应只用于本人信任的本机环境。

## 本人账号与机器人身份

- 回复和通知使用当前机器人的应用凭证。
- `FEISHU_PI_USER_CLI=0` 保留原来的限制：AI 不能使用用户令牌，只允许机器人身份和固定人物资料查询。
- 明确启用 `FEISHU_PI_USER_CLI=1` 后，用户态 CLI 只使用本人通过本工程 `/login lark` 或 `/login meegle` 授权的令牌。
- 不读取本机 CLI 的默认登录账号；没有有效令牌就拒绝，并引导授权。
- 普通 shell、浏览器和 MCP 不继承模型、飞书应用及用户令牌。MCP 所需密钥必须在配置中明确引用环境变量。

## 扩展与开发

```sh
npm run dev
npm run check
npm test
```

| 目录 | 职责 |
|---|---|
| `src/main.ts`、`src/assistant/` | 依赖装配和生命周期 |
| `src/runtime/` | Pi 会话、身份执行与队列 |
| `src/feishu/` | 消息、卡片、用户授权 |
| `src/permission/`、`src/guard/` | 规则匹配、模型审核、本人确认 |
| `src/browser/` | 浏览器服务和工具适配 |
| `src/tasks/`、`src/process/` | 后台任务、子进程和回收 |
| `src/mcp/` | MCP 配置、连接和工具适配 |
| `.agent/` | 系统提示、技能、权限、自定义工具、MCP 配置 |

依赖版本由 `package-lock.json` 固定，安装使用 `npm ci`。运行数据、会话、浏览器状态和密钥不入库。

文档：[能力与配置](docs/assistant-capabilities.md) · [架构](docs/architecture.md) · [命令](docs/commands.md) · [账号授权](docs/user-auth.md) · [数据](docs/data-management.md) · [工具扩展](.agent/README.md)。
