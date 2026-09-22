# mini-claw 与 OpenClaw 差距梳理

> 对比对象：`E:\源丶工程\mini-claw` 与 `E:\源丶工程\openclaw-main`。  
> 代码快照：2026-09-21。

## 先说结论

两边都把“模型调用、工具循环、会话、技能”作为核心，但产品定位不同：

- **mini-claw 是单飞书应用里的 Agent 产品**：直接使用 `@earendil-works/pi-coding-agent` 的 `AgentSession`，自己补上飞书消息、CardKit、身份、权限、审批和会话持久化。
- **OpenClaw 是多渠道 Agent 平台**：核心运行时、Gateway、路由、插件 SDK、CLI、Control UI、调度、沙箱和多 Agent 都是产品本体。

因此，差距不是“我们少接了几个 API”，而是：

> Agent 内核接入方式相近，但 OpenClaw 已经把外围能力产品化成平台；我们目前是一个聚焦飞书、单进程、单 Agent 的垂直实现。

还有一个容易混淆的点：OpenClaw 当前代码里有自己的 `@openclaw/agent-core` 和 `embedded-agent-runner`，并不是简单地把我们的 `AgentSession` 换个壳。两者共享 Pi/Agent 的设计脉络，但 OpenClaw 已经在运行时层做了大量自研扩展。

## 规模和边界

按工程目录做的粗略统计（不把统计数字当作质量分数）：

| 指标 | mini-claw | OpenClaw |
|---|---:|---:|
| 非测试 TypeScript 文件 | 53 | 约 5292 |
| 测试文件 | 36 | 约 647 |
| 内置扩展目录 | 0 | 139 |
| 技能目录 | 当前以 `.agent/skills` 约定为主 | 52 |
| UI | 无独立控制台 | 有 Web/Control UI、TUI 和移动端相关代码 |

这说明 OpenClaw 的优势主要来自长期积累的“平台面”，不是单次接入模型时 Agent loop 有多神秘。

## 能力对照

| 能力面 | mini-claw 当前状态 | OpenClaw 状态 | 判断 |
|---|---|---|---|
| Agent loop | Pi `AgentSession`、流式事件、工具调用、会话文件 | 自有 agent-core、嵌入式 runner、上下文引擎、模型/工具运行时 | 我们够用，但扩展边界较窄 |
| 飞书通道 | Lark WebSocket、CardKit 2.0、卡片回调、@、附件和用户身份 | 飞书只是众多 channel/plugin 之一 | 飞书体验我们更聚焦，平台能力明显落后 |
| 会话 | 按私聊/群/话题路由，单会话串行、可中断、换代、磁盘恢复 | agent/session key 路由，多 Agent、多来源、分叉、子 Agent、压缩和清理 | 我们有基础隔离，缺平台级编排 |
| 权限与审批 | `.agent/permissions.json`、fail-safe、ToolGuard、审核模型、授权卡 | allow/deny、sandbox、exec approval、pairing、设备/节点策略、渠道白名单 | 我们的飞书授权链路已经有特色，但隔离层次少 |
| 定时任务 | `schedule_manager` 已接通；本轮补齐 cron、一次性 `at`、固定间隔 `every`、时区 | `at/every/cron`，main/isolated/current/session，CLI/UI/RPC、SQLite、运行历史、重试、失败告警、webhook | 我们已具备 V1，距离 OpenClaw 的生产级调度还有一层 |
| 主动触达 | 暂无 heartbeat、webhook、邮件事件等通用触发器 | heartbeat、cron、webhook、Gmail Pub/Sub 等 | 高价值缺口 |
| 子 Agent | 暂无 `sessions_spawn` 类能力 | 原生 sub-agent、隔离上下文、结果回传、线程绑定、深度限制 | 高价值缺口 |
| 技能/插件 | `.agent/skills`、`.agent/tools`，工程内加载 | 公开 Plugin SDK、139 个扩展、provider/channel/tool/plugin 生命周期 | 架构能力差距大，但不应第一步照搬 |
| 模型和认证 | 一个当前模型配置，按飞书用户补充 Lark/Meegle 凭证 | 多 Provider、多账号、auth profile、fallback、模型目录和运行时切换 | 中长期需要抽象 |
| 记忆 | 每个 open_id 一个 Markdown 长期记忆文件 + memory 工具 | memory search、索引/向量扩展、引用、按 Agent/会话范围隔离 | 我们简单透明，检索能力不足 |
| 媒体和设备 | 图片/附件输入，CardKit 文本卡片 | 图片、音频、TTS、语音、浏览器、Canvas、节点/设备、视频等 | 产品范围尚未展开 |
| 控制面 | 无独立 Gateway/API/UI；主要依靠飞书命令和日志 | Gateway 控制平面、CLI、RPC、Web UI、TUI、服务化部署 | 最大的产品化差距 |
| 数据层 | JSON 原子写，`data/` + `work_space/`，单进程单实例锁 | SQLite 状态库、迁移、运行账本、诊断和更丰富的恢复语义 | 我们更轻，但并发/查询/审计能力有限 |
| 观测和运维 | 日志、`/status`、测试和启动自检 | 结构化诊断、运行记录、usage、状态面板、服务管理、doctor | 需要逐步补齐 |

## 前一版遗漏的差异

前面的能力表还不够完整。更准确地说，OpenClaw 与 mini-claw 的差距分为四层：控制平面、Agent 编排面、执行安全面和产品生态面。

### 1. Gateway 控制平面：不是一个端口，而是一套长期运行的中枢

OpenClaw 的 Gateway 是独立的长期服务，负责：

- 维护各渠道连接，并向 CLI、Web UI、WebChat、桌面客户端和自动化客户端提供统一 WebSocket RPC；
- 用 `connect → hello-ok` 完成握手、能力发现、事件订阅、请求/响应、序号和状态版本管理；
- 通过 JSON Schema 校验协议，副作用请求有幂等键和去重缓存；
- 统一提供 `health`、`status`、`send`、`agent`、`system-presence` 等控制方法；
- 支持 loopback、LAN、Tailscale、SSH tunnel 和远程 Gateway。

mini-claw 的 `main.ts` 是直接把 LarkTransport、Runtime、Bridge、ScheduleService 接到一个 Node 进程里。MiniPet 现在通过本地 stdin/stdout JSONL 接入，定位是轻量桌面前端适配器，不是支持远程客户端的 Gateway。

这意味着目前无法像 OpenClaw 那样做到“一个后台服务，多个客户端都通过同一个控制协议接入”。

### 2. 多 Agent 与路由：我们只有多会话，没有多大脑

OpenClaw 的 `agentId` 是完整隔离单元，包含：

- 独立 workspace、agentDir、认证 profile、模型配置和 session store；
- 按 channel、account、peer、群组或用户把入站消息路由到不同 Agent；
- 同一渠道可以挂多个账号，每个账号绑定不同 Agent；
- Agent 之间可以配置不同人格、技能、工具、沙箱和模型。

mini-claw 当前只有一个 Runtime、一个 `.agent/`、一个 workspace 和一套权限策略。`conversationId` 可以隔离历史，却不能隔离人格、工具注册、模型 profile 或工作目录。MiniPet、飞书私聊、群聊最终仍然进入同一个 Agent 实例体系。

### 3. 会话生命周期：我们有“存下来”，没有“长期运营”

OpenClaw 的 session 层还包含：

- DM scope：全局、按用户、按渠道+用户、按账号+渠道+用户；
- identity links：跨渠道识别同一个人；
- daily reset、idle reset、手动 reset；
- session maintenance 的最大条目数、过期清理和 dry-run；
- transcript 分支、fork、历史查询、session send/history/list；
- 自动 context compaction、压缩计数、压缩模型、memory flush、checkpoint successor transcript；
- 运行状态、token/usage、model/auth profile 变更和诊断字段。

mini-claw 的 SessionStore、Promise 队列、`/new`、`/stop`、空闲驱逐和磁盘恢复是可靠的基础实现，但它仍然是“会话文件管理器”，还不是带生命周期策略和上下文预算的 session platform。尤其是长对话没有自动压缩，历史越长，成本、延迟和失败概率都会增加。

### 4. 后台工作模型：定时只是其中一部分

OpenClaw 的后台执行至少包括：

- heartbeat：周期巡检，可静默，只有发现变化时才通知；
- cron：main、isolated、custom session 三种执行语义；
- webhook：外部 HTTP 事件触发 Agent；
- Gmail Pub/Sub：邮件事件触发；
- tasks：有 queued/running/terminal 状态的后台任务账本；
- sub-agent：独立会话、并发限制、超时、结果回传和 descendant delivery；
- CLI/background process：退出通知、状态追踪和清理。

mini-claw 现在只有定时任务 V1。它能持久化和执行任务，但没有统一后台任务实体、heartbeat、webhook 入站、任务取消/超时状态机、运行日志、失败告警和子 Agent 编排。

### 5. 执行安全：权限策略不等于隔离

mini-claw 的 `.agent/permissions.json`、deny、allow、ToolGuard、审核模型和授权卡解决的是“这个调用者是否允许调用这个工具”。这是有价值的应用授权层，但工具仍运行在当前 Node 进程所在的主机环境。

OpenClaw 额外提供了执行位置和隔离层：

- `exec` 可路由到 gateway、sandbox 或 paired node；
- Docker sandbox、SSH sandbox、OpenShell sandbox；
- non-main/all sandbox 模式和 shared/per-agent/per-session scope；
- sandbox browser、网络策略、文件挂载和 elevated escape；
- node host 本地 exec approvals、命令 allowlist/denylist；
- Gateway 访问认证、设备签名、设备配对和 token；
- DM pairing、channel allowlist、trusted proxy/Tailscale 身份。

mini-claw 当前没有 Docker/SSH/OpenShell 沙箱，也没有 Node 配对和远程执行审批。因此我们可以做到“谁能调 bash”，但还不能做到“即使允许调 bash，也把它限制在容器/远程节点里”。这是安全等级上的差异，不是权限配置项数量的差异。

### 6. 工具面：从四个基础文件工具到可编排设备平台

mini-claw 当前核心工具面主要是 `read`、`write`、`edit`、`bash`，再加上 memory、schedule、ask_user_question 和工程自定义工具。

OpenClaw 的工具注册面还包括：

- `exec` + `process`：前后台命令、日志、输入、取消和超时；
- `browser`：多 profile、快照、操作、上传、下载、远程 CDP、节点代理和 SSRF 防护；
- `web_search`、`web_fetch`、链接理解；
- `message`：跨渠道发消息、线程、反应、编辑、删除、置顶等渠道动作；
- `sessions_list/history/send/spawn`、`subagents`、`agents_list`、`session_status`；
- `cron`、`gateway`、`nodes`、`canvas`；
- 图片、音乐、视频生成，媒体理解、转写、TTS；
- MCP、ACP、provider-backed code execution。

所以缺口不是“再加几个工具描述”，而是缺少工具背后的执行目标、异步生命周期、节点代理和统一策略接口。

### 7. 媒体与设备：MiniPet 不是 OpenClaw Node

我们刚接入的 MiniPet 是一个本地 UI 前端，它能发送文字/图片并显示 `surface`，语音播报主要由 MiniPet 自己完成。它不等同于 OpenClaw 的 Node。

OpenClaw Node 是经过设备身份配对的执行端，可以暴露：

- Canvas 和 A2UI；
- 摄像头拍照、视频片段、屏幕录制；
- 屏幕截图、位置、系统通知；
- macOS/iOS/Android/headless node 的本地命令；
- Android 联系人、日历、短信、通知、设备状态等能力。

mini-claw 目前没有设备配对、节点能力声明、隐私权限和远程调用策略。因此 MiniPet 能作为前端，但还不能作为“设备节点”承载摄像头、屏幕和本地系统动作。

### 8. 插件系统：不是“扫描一个 tools 目录”

mini-claw 的扩展入口是工程内 `.agent/skills` 与 `.agent/tools`，启动时扫描，修改后通常需要重启。它适合当前单工程定制，但没有独立的发布/安装/卸载边界。

OpenClaw 有正式 Plugin SDK 和 manifest：

- 插件可以提供 channel、provider、tool、skill、memory、compaction、CLI、Gateway route、HTTP route、hook、node command 和 onboarding；
- 插件可以声明配置 schema、依赖、doctor 合约和运行时生命周期；
- 插件有 enable/disable/allow 列表、独立状态目录、迁移和测试支持；
- 139 个 extension 目录中包含渠道、模型、浏览器、Canvas、媒体、记忆、诊断、MCP 和 provider 等不同类型；
- 技能有 workspace/project/personal/managed/bundled 多层优先级、allowlist、ClawHub 安装和 Skill Workshop 审核流程。

这部分是 OpenClaw 最明显的生态护城河，不能用“多复制一些 SKILL.md”替代。

### 9. Feishu 能力也不只是渠道数量

OpenClaw 的 Feishu extension 本身已经拆成独立插件，并包含多账号、渠道配置、线程/会话绑定、消息去重、出站重试、反应、评论、@、typing、媒体、云文档、云盘、多维表格、知识库、权限和 doctor/security contract 等模块。

mini-claw 的 Feishu 集成在机器人消息、CardKit、身份授权、审批授权和内部 IT 流程上更聚焦，但没有把渠道能力抽成可复用插件，也没有同等丰富的飞书资源操作面。我们现在依赖 lark-cli 和工程技能补能力，而 OpenClaw 把其中大量能力直接纳入 channel plugin/tool contract。

### 10. 模型与凭证：单一当前模型 vs profile/fallback 平台

mini-claw 当前有一个运行中的模型配置，支持 `/model` 切换；Guard 模型独立用于审核，但不是主模型的 fallback 链。

OpenClaw 支持：

- provider/model catalog 与 alias；
- 多 auth profile 轮换；
- 主模型 + fallback 链；
- 按 Agent、session、cron job 覆盖模型和 auth profile；
- provider preflight、故障判定、切换重试和模型可用性诊断；
- SecretRef、环境变量、文件/命令等不同密钥来源。

因此我们的模型切换解决的是“当前服务用哪个模型”，OpenClaw 解决的是“每个运行单元在多供应商、多凭证、故障切换下如何稳定完成”。

### 11. 记忆与上下文：Markdown 透明性 vs 可检索知识系统

mini-claw 的 memory 是按 open_id 分文件的 Markdown，读写透明、容易备份，适合个人长期偏好和少量事实。

OpenClaw 的 memory slot 由插件提供，默认路线可以是 SQLite 的关键词+向量混合检索，也可以接 LanceDB、wiki 等后端，并支持自动 recall、auto-capture、引用、memory flush、dreaming 和知识 wiki 层。

我们的缺口不只是“没有向量库”，还包括：召回时机、来源引用、记忆范围、过期/冲突处理、会话压缩前的自动沉淀，以及多 Agent 之间的记忆隔离。

### 12. 配置、迁移和自诊断

mini-claw 使用 `.env`、少量 JSON 存储和 setup 向导；配置错误通常在启动或第一次使用时暴露，运行中没有统一 schema UI。

OpenClaw 有 JSON5 schema、配置热重载、Control UI 表单、严格校验、last-known-good、doctor/doctor --fix、升级迁移、插件自有配置 schema 和配置审计。

运维侧还包括 Gateway daemon 安装、launchd/systemd、Docker 部署、日志查看、health/status/security audit、更新 channel、备份迁移和远程连接。mini-claw 目前更像一个需要 npm/tsx 直接托管的应用进程。

### 13. 可观测性和运行账本

OpenClaw 把一次运行当作可追踪对象：有 runId、task 状态、cron run ledger、usage、诊断事件、heartbeat/cron/agent/channel 事件、失败分类、超时 watchdog、Prometheus/OTel 插件和 Control UI 状态页。

mini-claw 现在主要依赖文本日志、会话文件、消息状态、定时任务的有限结果字段和模型统计小字。出了问题可以复现和查日志，但还不能按 runId 查看“何时排队、在哪个阶段、用了哪个模型、调用了哪些工具、最终投递到哪里”。

## 差距的本质

可以用下面的分层来判断：

| 层 | OpenClaw | mini-claw | 当前判断 |
|---|---|---|---|
| 模型循环 | 自研扩展的 Agent Runtime | 复用 Pi AgentSession | 能力接近，扩展点不同 |
| 会话编排 | 多 Agent、路由、后台任务、压缩 | 单 Agent、多会话、队列 | 这是中等到大差距 |
| 控制平面 | Gateway + RPC + UI + CLI + 节点 | main.ts 进程 + 飞书/MiniPet 入口 | 这是最大差距 |
| 执行安全 | 权限 + 审批 + sandbox + node | 权限 + Guard + 授权卡 | 隔离能力明显不足 |
| 扩展生态 | Plugin SDK + 139 extensions + ClawHub | 工程内 skills/tools | 生态差距最大 |
| 垂直体验 | 多渠道广度 | 飞书内部场景更深 | 这是我们的优势 |

## 我们已经做好的部分

不要把工程低估成“只有一个机器人壳子”。当前已经有一条完整的飞书 Agent 链路：

1. Pi 会话创建、历史落盘、图片/附件归档和 `/new` 换代。
2. 同一会话串行、跨会话并行、`/stop` 中断、消息认领和卡住消息清理。
3. CardKit 流式更新、工具状态展示、授权卡、Ask User 卡片和真实飞书联调。
4. 按用户 open_id 的身份解析、Lark Device Flow、凭证加密存储和会话凭证注入。
5. 权限 fail-safe、路径规则、工具审核、授权一次和卡片点击者中文姓名日志。
6. Slash Command 上电注册、`/restart` 开发服务重启、模型切换、状态查看和登录命令。
7. 个人长期记忆、自定义技能/工具、数据清理、实例锁和多处可靠性测试。

这些能力已经足以支撑“公司内部飞书 IT 服务台 Agent”这个垂直产品。当前不应该为了追 OpenClaw 的目录数量而失去飞书体验和权限边界。

## 定时任务：当前可用范围

定时任务通过模型调用 `schedule_manager` 管理，任务按创建者 open_id 隔离，触发时使用创建者身份、权限和目标会话。

支持三种形式：

| kind | 示例 | 适用场景 |
|---|---|---|
| `cron` | `0 9 * * *` | 每天 09:00；可带 `Asia/Shanghai` 等 IANA 时区 |
| `at` | `2026-09-21T18:30:00+08:00` | 一次性提醒；成功或失败后自动停用，档案保留 |
| `every` | `1800000` | 每 30 分钟执行一次，单位毫秒 |

自然语言示例：

- “每天早上 9 点，汇总我的飞书待办并发到当前会话。”
- “今天 18:30 提醒我提交日报。”
- “每 30 分钟检查一次服务状态，有异常就说明原因。”

已经具备：持久化、重启恢复、启停、删除、立即执行、执行结果记录、任务归属隔离、同一任务防并发重入，以及飞书 CardKit 结果回卡。

还没有做到：运行历史明细、失败重试退避、失败告警、错过任务补偿策略、专用 `/schedule` 指令、控制台编辑、webhook 投递和任务级模型/工具限制。这些是定时 V2，而不是当前 V1 的阻塞项。

## 最值得做的特性路线

### P0：先让一个 Agent 长期稳定工作

#### 1. 定时任务 V2

在当前 V1 上继续补：

- `nextRunAt`、每次运行的摘要和耗时；
- 最近 N 次运行记录，而不是只保留 `lastStatus`；
- 错误退避、最大重试次数和失败通知；
- `/schedule list|add|pause|resume|run|remove` 卡片化入口；
- 任务级超时、工具白名单和明确的“是否允许写入/发消息”；
- 首次上线时做错过任务策略：默认不补跑，用户显式选择后再补跑。

这是最值得继续做的一项，因为它直接把“会聊天”变成“会持续工作”。

#### 2. Heartbeat / 主动巡检

增加一个低频心跳，让 Agent 定期检查固定事项，但只有发现变化或异常才发消息。它和 cron 的分工应保持清晰：

- cron：精确时间、明确任务、一定要执行；
- heartbeat：周期巡检、允许安静、适合读状态和发现异常。

第一版可以只服务管理员私聊，不开放群聊主动广播，降低误触达风险。

#### 3. 会话压缩与运行账本

目前历史持续落盘，但还没有 OpenClaw 那种成熟的 context compaction、token 预算、每轮运行账本和可恢复终态。优先补自动摘要、最大历史窗口、模型调用耗时/token 统计，避免长期会话越聊越慢。

### P1：把单 Agent 做成可扩展服务

#### 4. 子 Agent / 后台任务

提供 `sessions_spawn` 类工具：主会话派出一个独立任务，后台执行后回传摘要。第一版只允许管理员使用，限制并发数、最大时长和工具集合，不做任意递归。

#### 5. Gateway 与运维控制面

先做一个本机管理 API 或简单 Web 页面，提供健康状态、活动会话、定时任务、最近错误、模型配置和安全策略查看。飞书仍是主要交互入口，控制面只负责运维，不替代聊天。

#### 6. 插件/通道边界

把当前 `feishu/` 抽出稳定的 Channel Adapter 接口，至少统一：入站消息、出站文本/卡片、附件、用户解析、回调动作。先不接第二个渠道；接口稳定后，未来接 WebChat/Telegram 才不会重写 Agent 层。

#### 7. SQLite 状态层

当任务历史、运行账本、事件、审计和控制面一起出现时，再把 JSON 状态迁移到 SQLite。现在 JSON 原子写足够简单可靠，没必要为了“像 OpenClaw”提前引入数据库。

### P2：扩大产品边界

- 多模型 Provider、fallback、按任务选模型；
- 语音输入/TTS 输出和媒体转码；
- 浏览器和外部网页工具；
- 向量记忆、全文搜索和引用；
- 更多飞书原生能力：日历、任务、审批、云文档、多维表格；
- 第二个消息渠道和真正的多 Agent 路由。

## 建议的实施顺序

```text
定时 V2（运行记录/失败治理）
        ↓
Heartbeat（只给管理员私聊）
        ↓
会话压缩 + token/耗时账本
        ↓
子 Agent（严格并发/时长/工具边界）
        ↓
控制面与 Channel Adapter
        ↓
SQLite、插件 SDK、多渠道、媒体和浏览器
```

## 不建议现在做的事

- 不要直接复制 OpenClaw 的 139 个扩展目录；它们会带来依赖、权限、升级和测试负担。
- 不要先做多渠道；在飞书 CardKit、审批卡、授权卡和 @ 语义尚未沉淀成适配器前，第二渠道只会放大耦合。
- 不要把所有状态立即迁移 SQLite；先把运行语义和审计字段定义稳定，再迁移才不会反复改表。
- 不要让定时任务默认拥有管理员全部工具；调度是异步执行，任何授权扩大都必须显式记录任务创建者、工具范围和投递目标。

## 最终判断

如果目标是“飞书内部效率助手”，我们与 OpenClaw 的核心差距约为**平台能力差距**，不是 Agent 能力差距。当前最合理的路线是保留轻量单进程和飞书深度集成，优先补齐定时 V2、Heartbeat、会话压缩和子 Agent；等这些能力证明产品方向后，再引入 Gateway、SQLite 和插件化。

相关实现入口：

- 定时服务：[src/schedule/service.ts](../src/schedule/service.ts)
- 定时工具：[src/schedule/tool.ts](../src/schedule/tool.ts)
- 权限策略：[.agent/permissions.json](../.agent/permissions.json)
- 当前架构：[architecture.md](architecture.md)
