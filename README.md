# feishu-pi

部署在本人电脑上的个人 Agent，基于 Pi AgentSession。飞书提供远程交互入口；管理员可使用浏览器、后台任务和 MCP 等执行能力，普通用户可以私聊、在群里 @ 机器人聊天和使用表情包。

这是基于 Pi AgentSession 的个人飞书助手。

## 开始使用

需要 Node.js 22+、npm、可用的模型接口，以及自己的飞书机器人。浏览器默认复用 Windows 上已安装的 Edge；可改为 Chrome。Python 仅在使用 Python 自定义工具时需要。

```sh
npm ci
npm run setup
```

向导配置飞书应用。在生成的 `.env` 中填写：

```dotenv
FEISHU_PI_OWNER=ou_你的飞书OpenID
FEISHU_PI_MODEL_NAME=你的模型名称
FEISHU_PI_MODEL_BASE_URL=你的模型接口地址
FEISHU_PI_MODEL_API_KEY=你的模型密钥
```

然后运行：

```sh
npm start
```

机器人只处理 `FEISHU_PI_OWNER` 的私聊，以及本人在群中 @机器人的消息。其他人不能启动 Agent 或批准卡片。本人尚未配置或无法识别时，服务停止启动，不自动开放给所有人。

飞书应用需要启用机器人、长连接和 `im.message.receive_v1`、`card.action.trigger`。向导提供预置权限；应用后台提示待发布时，需要发布才能生效。Open ID 可以通过飞书开发者后台的用户 ID 查询工具获取；使用本机器人应用对应的 ID。

## 个人能力

| 能力 | 实现 |
|---|---|
| 权限 | `deny` 硬拒绝；`ask` 审核模型；`allow` 确定性放行；未匹配默认拒绝 |
| 浏览器 | 按需启动 Playwright CLI，持久化独立登录状态，页面快照、点击、输入、上传、截图和人工接管 |
| 记忆 | 基于 Memoria 的私聊记忆自动提取、分层存储、按重要度和时效召回；每轮提炼会调用当前模型 |
| 后台任务 | 启动、状态、日志、取消、超时、并发限制、持久化记录和完成通知 |
| MCP | 按需连接 stdio / Streamable HTTP / 显式 legacy SSE；工具发现与调用、资源和提示读取 |
| 飞书 | 文本、图片、语音、附件、引用、CardKit 2.0 流式回复、人物提及与本人授权 |
| 定时任务 | 一次性、固定间隔、cron、时区、启停和手动执行 |
| 扩展 | Markdown 技能，TS/JS/Python 工具和 Pi 扩展 |

没有默认模型心跳或定期后台轮询。本人飞书私聊结束后会调用模型提炼记忆。浏览器和 MCP 未使用时不启动。只有你明确创建的定时任务会定期启动 Agent。

## 表情包来源

本地表情库位于 `data/stickers/`，默认不随 Git 提交。`sticker_search` 按名称、情绪和描述检索（加权字段 + 中文二元组兜底），`sticker_send` 将所选表情发送到当前飞书会话；黑白名单在 `.agent/stickers.json`，用户配置优先、模型不可改。各套素材的作者、来源及授权以原项目和图库目录中的说明为准：

| 表情包 | 来源与署名 |
|---|---|
| 大肥鱼 / GPT 娘（nekowhale） | [dsh-nekowhale-stickers](https://github.com/Loping151/dsh-nekowhale-stickers)；表情作者 [可以叫我云大人 / 雾雪](https://space.bilibili.com/103739)，由 [kiriyuki.com](https://kiriyuki.com) 制作；角色设计来自 ZipZipPipe 和上善无形。知识数据为 CC BY-NC 4.0，图片版权归作者，非商业分享须保留署名。 |
| Clawd Dev Life（clawd） | [alwinecor/clawd-stickers](https://github.com/alwinecor/clawd-stickers)，40 个表情各有浅色和深色版。项目贡献内容按其 LICENSE 授权；Clawd 等第三方角色权利不包含在该授权中。 |
| DeepSeek 鲸鱼娘（whale-girl） | [DejavuMoe/deepseek_wale_girl](https://github.com/DejavuMoe/deepseek_wale_girl)，作者 Dejavu Moe；104 张动态表情。 |
| 蓝发鱼娘（bluefish） | [keeshakulbida948-tech/dsh-plugin-sticker](https://github.com/keeshakulbida948-tech/dsh-plugin-sticker)，109 张图片；原项目 README 标注 MIT，图片原作者及第三方权利未逐项确认。 |
| 大肥鱼动作动图（emotelab） | [BrickAZ/deepseek-chan-emotes](https://github.com/BrickAZ/deepseek-chan-emotes)，角色来源为 Steam 创意工坊“蓝色大肥鱼”，作者飞天豆之助；动图由 EmoteLab 导出，使用须遵守原素材授权及 EmoteLab EULA。 |
| 桌宠动作库（dsh-pet） | [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)；109 段 10 秒动作 GIF（上游 `assets/preview/` 官方预览，母版为 640×360 透明 webm）与 27 张表情图。代码 MIT，素材禁止商用；宠物形象为社区二创的 DeepSeek「大肥鱼」（非官方），授权 CC BY-NC-SA 4.0。 |

来源说明和许可文件也保留在对应图库目录中；迁移或备份时需单独保存 `data/stickers/`。

## 人格与记忆

当前人格为大肥鱼，定义在 `.agent/SYSTEM.md`。每次启动会保存一份人格快照；`npm run persona -- list` 查看版本，`npm run persona -- restore <版本ID>` 恢复并备份恢复前版本，重启后生效。旧版小月人格也已保存到版本目录。

本人飞书私聊在每轮回复后调用当前模型，从对话提炼可长期记住的事实、偏好和事件；下轮回复前用 Aurabot 的中文二元切词、BM25、重要度和遗忘曲线检索相关记忆；长期身份事实常驻。记忆仅用于本人私聊，群聊不注入。每次提炼会产生额外模型调用，模型失败不会阻断对话。敏感内容会被过滤，未配置自动彻底删除。原始会话历史不再按七天自动删除，但过去已删除的内容无法恢复。

其他飞书用户可以私聊大肥鱼，也可以在群里 @ 她聊天。每个人按飞书 Open ID 独立提取长期特点、偏好和近期事件，召回会参考重要度、使用天数和时间衰减；明确纠正的旧事实会标为过时保留。群内记忆按群和发言人隔离，不把私聊记忆带入群里；普通用户的群会话互相隔离。数据存在 `data/person-memory/`，不同用户与平台不会按昵称合并。普通用户可使用表情包搜索和发送，不注册本机文件、命令、屏幕控制、浏览器或管理员账户工具；管理指令仅管理员可用，个人记忆管理除外。模型提炼可能遗漏或理解错误，只有它识别到明确纠正时才会更新。

私聊另外提炼“共同聊天”和对说话人的谨慎印象，按飞书用户分别存于 `data/relationship-memory/`；记录包含用户原话片段和时间。印象要有两条不同消息的支持才会自动召回，仍作为待核实的参考。用户明确纠正时模型可将旧条目标记为停用，也可以通过 `/memory` 查看、停用和恢复。它不是完整的 N.E.K.O. 记忆系统：语义理解仍依赖模型，模型提炼失败时不会阻断聊天，且这部分每轮会增加一次模型调用。

记忆提取使用当前发言人的消息正文，不把单独附加的引用、人物表或平台提示当成发言人的陈述。提取在后台执行；如果刚才的提取尚未完成，下一轮会先使用已完成的记忆，刚说的内容可能要稍后才能作为长期记忆召回。

召回的记忆只临时加入当前模型请求，用户的会话历史保存原消息，不重复持久化召回资料。历史中自然生成的助手回复仍正常保留。

可以直接问“你还记得我什么”，系统会挑选该用户近期或较重要的记忆供模型回答。同一驻留会话的最近几轮正文也会作为提取时的参考，帮助理解“刚才说错了”之类的纠正；这些上下文不跨用户，也不作为事实直接保存。

飞书私聊里可使用 `/memory list` 查看提炼记忆及状态，`/memory disable 记忆ID` 停用，`/memory restore 记忆ID` 恢复。每个人只能操作自己的记忆；恢复被新版本替代的访客记忆时，会同时停用其当前替代版本。本人的旧事实若已被自动更新替换，旧内容保留在备份中，尚不能通过此命令单条恢复。停用不是删除：原始会话、近期对话索引和旧备份仍可能保留相关信息，之后不同表述的新记忆也可能再次被提炼。

问“上次我们聊了什么”时会提供最近完成的对话片段，并结合近期提炼出的经历；片段有长度限制，不保证覆盖上次聊天的全部内容。近期片段按用户保存在 `data/recent-conversations/`，最多保留 40 轮，每次召回最近 3 轮；该索引从功能启用后的新对话开始建立。对话或记忆提炼中如某轮含凭证关键字或已配置的密钥，该轮用户消息及助手回显都不进入这份索引或提炼上下文；原始会话历史仍按项目原有规则保存。

问“我们之前聊过蓝鲸吗”之类的话题问题时，会检索本人近期 40 轮片段，并按需扫描身份明确匹配的历史私聊会话；群聊和其他人的私聊不参与。历史扫描最多检查近期 300 个会话目录和 100 个文件，单文件不超过 3 MiB、合计不超过 16 MiB，扫描时间约 1 秒。检索基于关键词，可能漏掉同义表达或超出范围的记录；没有命中不能证明过去从未聊过。

历史单条消息最多检索前 12,000 个字符，命中长消息时会返回话题附近的片段。长期记忆与历史片段并行读取，各自仍受超时限制。

私聊还有借鉴 Aurabot 的轻量心情状态：少量明确针对角色的褒贬语句会调整状态，并以 8 小时半衰期回到平常；状态影响语气，不记录原话，不对用户的情绪作判断。状态保存在 `data/companion-mood.json`。

记忆保存在 `data/companion-memory/`，不随 Git 提交；每次变更先保留本地备份。记忆提炼借鉴 [Memoria.chat](https://github.com/rullerzhou-afk/memoria-chat)，召回算法移植自 [Aurabot](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq)，许可证和修改说明见 `vendor/`。旧版 `memory` 工具保持停用，旧数据不会自动导入。B 站互动记录另存于 `data/bilibili/interactions.jsonl`；`bili_person` 按 UID 查实际回复过的人及往来记录，读取评论时会带出与该用户的近期互动和已保存的事实。模型可以通过 `bili_remember_person` 保存有已回复评论为依据的人物事实，来源记录在 `data/bilibili/person-facts.jsonl`；旧记录若没有 UID 或对方原文，无法补造。此功能依赖模型主动调用，尚未实现自动过时更新或遗忘评分。

## B 站

管理员可通过 MCP 搜索视频，`bili_explore` 按关键词搜索未读视频，`bili_watch` 一次读取视频资料、字幕和评论并记录成功读取的视频；`bili_check_replies` 查看回复通知并标记已回复项。登录后可按权限流程评论。各项读取可能单独失败，记录不代表看过视频画面。实现基于 [adoresever/bilibili-mcp](https://github.com/adoresever/bilibili-mcp)，保留其 MIT 许可证，源码位于 `tools/bilibili-mcp/`。

自动化借鉴 [Aurabot](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq) 的定时浏览和回复流程，是可选服务：`.env` 中 `FEISHU_BILI_AUTO_AVAILABLE=false`（默认）时不加载服务或启动循环；改为 `true` 并重启后，登录 B 站并在管理员飞书私聊中发送 `/bili-auto on` 启用，`/bili-auto status` 查状态，`/bili-auto run` 立即请求运行一轮，`/bili-auto off` 停用。关闭配置开关不会删除 `data/bilibili/automation.json` 中的状态；之后重新加载服务时，若该状态仍为启用，会自动恢复运行。若不希望恢复，先在服务可用时发送 `/bili-auto off`。开启后每 4 小时探索一轮，每 20 分钟检查评论回复；模型根据大肥鱼人格、兴趣和实际资料决定评论或沉默，每天最多成功发表评论 2 条、回复 5 条。遇到登录失效、验证码、风控或频率限制会暂停当天；登录修复后可重新发送 `on`，风控或限频暂停当天不解除。发送前持久化去重记录，网络结果不明时不自动重试。每次 MCP 调用仍遵循 `.agent/permissions.json`；如审核模型要求本人确认，自动化会等待授权或在拒绝/超时后停止本轮，因此不能保证无需人工干预。不会自动私信、发动态或上传视频。普通的手动 B 站 MCP 工具不依赖此开关。

如还希望大肥鱼向管理员飞书私聊分享浏览到的视频，在上述自动化启用的基础上设置 `FEISHU_BILI_SHARE_AVAILABLE=true` 并重启（默认关闭）。模型会决定分享或跳过；每天最多一次，北京时间 23:00 至次日 08:00 不发送，同一视频不会重复分享。发送前记录尝试，结果不明确时不自动重试；没有单独的消息队列，也不会补发免打扰时段错过的视频。

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
- `MINICLAW_USER_CLI=0` 保留原来的限制：AI 不能使用用户令牌，只允许机器人身份和固定人物资料查询。
- 明确启用 `MINICLAW_USER_CLI=1` 后，用户态 CLI 只使用本人通过本工程 `/login lark` 或 `/login meegle` 授权的令牌。
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
| `src/assistant/companion-memory.ts`、`vendor/memoria/` | 基于 Memoria 的自动记忆适配 |
| `src/tasks/`、`src/process/` | 后台任务、子进程和回收 |
| `src/mcp/` | MCP 配置、连接和工具适配 |
| `.agent/` | 系统提示、技能、权限、自定义工具、MCP 配置 |

依赖版本由 `package-lock.json` 固定，安装使用 `npm ci`。运行数据、会话、浏览器状态和密钥不入库。

文档：[能力与配置](docs/assistant-capabilities.md) · [架构](docs/architecture.md) · [命令](docs/commands.md) · [账号授权](docs/user-auth.md) · [数据](docs/data-management.md) · [工具扩展](.agent/README.md)。
