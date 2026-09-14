# feishu-pi 架构设计

## 目标与定位

feishu-pi 是深度集成飞书人员身份、会话和权限的 Agent 应用平台。Pi 提供 Agent loop、模型适配、Session 和编码工具；本工程负责飞书消息、按人或群的会话管理，以及按身份的权限控制与定时任务。

核心能力及当前状态：统一飞书上下文（已落地）、会话按人或话题隔离（已落地）、两档身份的权限管控（已落地：管理员/用户，策略文件统一配置）、工具调用审核与人工授权（已落地：策略 → 智能体综合判断 → 授权卡）、定时任务（已落地：cron 调度 + 结果推送）、技能使用统计（已落地）、用户飞书身份授权（已落地：Device Flow `/login` `/logout`，用户 token 按 openId 存储与静默续期）。租户组织关系、飞书业务资源权限暂不纳入当前范围。

## 选型边界

Pi 是本工程的运行时底座。feishu-pi 仅使用其公开 SDK（`@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai`），不 fork、复制或修改 Pi 核心；因此可以复用成熟的 Session、模型流、Agent tool loop 和 `read`、`write`、`edit`、`bash`。

OpenClaw 是覆盖多渠道、Gateway、工具生态和运行管理的完整 Agent 产品。feishu-pi 借鉴其会话路由和渠道适配的边界设计，但不引入多渠道、CLI/TUI、MCP 编排和产品级运行管理，因为这些能力不服务当前单一飞书机器人的闭环。

Hermes 强调长期记忆、经验沉淀和自我改进。feishu-pi 借鉴其记忆应独立于短期上下文、可审计并按价值沉淀的原则，但不会一开始引入复杂检索或向量数据库；记忆能力将按飞书业务逐步接入。

这条路线避免两个极端：从零实现 Agent runtime 会重复 Pi 已解决的问题；直接采用 OpenClaw 或 Hermes 则会带来单一飞书场景不需要的依赖、部署复杂度和响应开销。

## 分层

```text
飞书消息（文本 + 图片 + 文件）
  ↓
飞书传输层（LarkTransport：WS 长连接、归一化、用户资料、会话 ID、附件下载、卡片回调）
  ↓
会话层（ConversationManager：按用户或话题隔离、串行队列、持久化映射）
  ↓
技能与权限层（统一策略文件：工具/命令/读写范围按身份过滤 + deny 第 0 层 + ToolGuard：策略 → 智能体 → 授权卡）
  ↓
Agent 运行时（Pi AgentSession + 内置工具 + .agent 自定义工具 + 定时任务）
  ↓
回复层（FeishuAgentBridge → CardKit 2.0 流式卡片 + spinner / 表情反馈 + 统计小字）
```

所有技能都通过 `FeishuContext`（`src/context/types.ts`）获取调用者信息，不自行解析飞书原始事件：

```ts
interface FeishuContext {
  userOpenId: string;      // 用户 Open ID
  userName?: string;       // 展示名：中文名 > 英文名 > Open ID
  en_name?: string;        // 英文名
  department_name?: string[]; // 部门名列表
  chatId: string;          // 会话 ID
  threadId?: string;       // 话题 ID
  chatMode?: "p2p" | "group" | "topic"; // 会话模式（传输层查询并缓存）
  conversationId: string;  // 完整会话标识
  isAdmin?: boolean;       // 是否管理员
}
```

`FeishuContext` 用于身份组判定（组成员按 openId/姓名匹配）、权限过滤、会话命名与日志，**尚未注入到模型提示词**（AI 在对话中感知不到调用者身份，「同一技能/工具内部按身份分支」待实现）。

## 飞书传输层

`LarkTransport`（`src/feishu/lark-transport.ts`）使用飞书官方 Node SDK 的**底层** `WSClient + EventDispatcher` 建立长连接，而非高层 `LarkChannel` 封装。原因有二：卡片回调 handler 的返回值需要原样进入 ACK 数据体（与 Go 官方 SDK 行为一致，LarkChannel 会丢弃）；LarkChannel 的去重逻辑会静默吞掉事件。连接由官方 SDK 自动重连；应用层设置 15 秒握手超时、30 秒 ping 超时。

消息处理管线（`dispatchMessage`）：

1. 过滤机器人自己的消息；
2. 查询用户资料（`LarkCli` 三步策略，见下）；
3. 构造 `conversationId`（规则见会话层）；
4. 下载图片/文件附件，把本地路径写入消息文本供 Agent 直接 `read`；
5. 清洗 @机器人 标记；
6. 判定 isAdmin 后交给上层 handler（fire-and-forget，不阻塞 SDK 事件循环）。

`card.action.trigger` 卡片回调路由：授权卡（`tool_approval` / `forward_approval`）转交 PermissionBroker；选项卡（`ask_user`）转交 AskBroker（校验存在性/一次性 token/仅提问对象本人）；模型切换按钮校验管理员后写回 `.env` 并触发热切换。

用户资料查询与缓存（`LarkCli`，`src/feishu/lark-cli.ts`——类名为历史遗留，与外部 lark-cli 工具无关）：**唯一通道为管理员身份**——FEISHU_ADMIN 通过 `/login`（Device Flow）授权的 user token 调用 contact API（获取中文名/英文名/department_ids，再经部门批量接口换部门名）。数据范围 = 管理员的**组织架构可见范围**（管理员默认全组织可见），与应用通讯录权限范围无关，应用可用范围外的外部成员同样可查。管理员通道未命中（**跨租户外部用户**不在本组织通讯录）→ 降级群成员名单（机器人身份，实时分页查找）取中文名。全部通道失败也落盘**冷却档案**（openId + 旧资料，冷却 1 天后自动重试，应对"刚入群名单未同步"等临时失败）；成功档案缓存 3 天到 `data/users/{appId}_users.json`。scope 已内置默认（contact 查询两项，无需配置环境变量）；前置：管理员完成 `/login`。历史版本曾 spawn 外部 lark-cli、曾依赖机器人通讯录权限，均已移除。

> **数据权限的三层模型**：① API 权限（scope，开发者后台开通）决定"接口能不能调"，两种 token 都需要；② 应用身份（tenant token）的数据范围 = 应用的**通讯录权限范围**（开发者后台数据权限配置）；③ 用户身份（user_access_token）的数据范围 = 该用户的**组织架构可见范围**（管理后台配置），与应用通讯录范围无关——管理员默认全组织可见。

## 会话层

`ConversationManager`（`src/runtime/conversation-manager.ts`）按 `conversationId` 复用 Pi Session，会话键由消息所在飞书会话类型决定：

| 场景 | 会话归属 | conversationId |
|------|---------|----------------|
| 私聊 / 普通群 | 按用户隔离 | `{openId}-chat:{chatId}` 或 `{openId}-{chatId}:thread:{threadId}` |
| 话题群的话题 | 话题内共享 | `topic:{chatId}:{话题根消息ID}` |
| 定时任务 | 按任务隔离 | `{创建人}-schedule:{任务ID}` |

同一会话通过 Promise 队列串行处理，新消息到达时 `abort()` 打断在途请求；不同会话并行。`/new` 在话题内被禁止（共享会话不允许单人清空）。

增量持久化：`conversationId → sessionFile` 的映射在 Pi 首个 `message_end` 事件落盘时就写入 `conversations.json`——运行时还会提前调用 `appendSessionInfo` 写入会话头使 sessionFile 立即可用，响应中途被中断或进程退出，下次也能恢复到同一会话。服务重启后按映射重新打开 Pi Session 继续上下文。

## 权限与 Guard

两级机制：**静态的策略过滤**决定会话里有哪些工具、可读写哪些路径，**动态的 Guard** 审核每次工具实际执行。

### 统一权限策略（一个文件，多个身份组）

全部权限集中在 `.agent/permissions.json`（`src/permission/policy.ts` 解析），文件只有两个输入——**deny**（全局禁止读写的路径 glob 数组，与内置密钥/凭据默认合并，对所有人含管理员生效）与 **allow**（各身份组的规则数组）。allow 内保留组名 **common**（所有人默认拥有的基础权限，每个用户自动叠加）与 **admin**（FEISHU_ADMIN 自动属于），加任意命名的用户组——团队组命名 group_1、group_2……（组员宏 `FEISHU_GROUP_1` 纯数字简写对应 group_1）。每组规则：`Read(路径glob)`、`Write(路径glob)`、`Tools(工具名)`、`Bash(命令前缀)`。生效范围 = common ∪ 所属各组。

生效范围 = 命中组的规则并集；策略文件 mtime 热重载，新会话生效；策略文件缺失/写坏按保守默认处理（仅技能目录可读、无工具）。

**deny 第 0 层**（策略文件顶层 `"deny"` 键）：与内置默认模式（`.env` 家族、密钥/证书、SSH 私钥、凭据类文件名）合并为禁止清单，先于一切 allow 规则——read 路径、write/edit 路径、bash 命令 token 命中即拦截，**对所有人（含管理员）生效且不走授权卡**：`.env` 等敏感配置绝不允许经智能体读或写。策略文件缺失时内置默认仍然生效（fail-safe）。模型侧另有系统提示「密钥安全规则」：确需返回敏感值时必须用星号遮蔽。

**工具与技能零改造**：说明书放在 `.agent/skills/*.md`，不含任何权限信息，约束全部由策略文件表达、由过滤层执行。

| 身份 | Custom Tools | 内置工具 | 可读范围 |
|------|-------------|---------|---------|
| owner | 策略 tools 名单（默认 `*`） | 名单内的 read/bash/write/edit | 策略 read 范围（默认 `**`） |
| user | 策略 tools 名单 | 名单内的 bash / read | 策略 read 范围（默认技能目录） |

### ToolGuard（bash 密钥过滤 → 策略 → 智能体 → 授权卡）

所有身份（含负责人）的每次工具调用都经过 `beforeToolCall` 钩子（`src/guard/`）：

```text
⓪ deny 规则：read 路径（runtime 分支）、write/edit 路径、bash 命令 token 命中禁止清单 → 一律拦截（对所有人含管理员，不走授权卡）
① read：先判技能可见范围（skills 字段），再判可读范围（read 字段）；
   范围外直接拦截不弹卡（能力问题不问人），范围内免审放行
② bash：命令命中组 bash 名单 → 放行
③ write/edit：路径命中组 write 范围 → 放行
④ 其他工具：命中组 tools 名单且未标 risk: "high" → 放行
⑤ 策略未命中 → 智能体综合判断（以该组策略为参考）：
   符合授权意图 → 放行；超出意图/不确定 → 授权卡
⑥ 智能体未配置 / 超时 / 异常 → 直接授权卡（fail-safe，负责人单次确认）
```

智能体审核（`PolicyJudge`，`src/guard/judge.ts`）解决"复合命令永远命中不了前缀规则"的问题：以调用者所属组的策略为参考，综合判断策略外调用是否符合授权意图。多模型并行取安全交集；未配置、超时、异常一律 ask（fail-safe）。授权卡中的敏感参数（token/password/api_key/secret/cookie）脱敏展示。

### 为什么技能不配权限

技能（Markdown 文档）不承载能力，只承载流程说明——把文档藏起来挡不住用户让 AI 干同样的事（模型凭自身知识就会尝试），而真正的执行手段（工具与命令）已由策略文件按组授权。技能的 `permission` frontmatter 已废弃。

### 技能使用统计

`beforeToolCall` 在 read 范围判定通过后记录使用事件：当读取命中技能目录下的 `.md` 时，向独立事件流 `data/stats/skill-usage.jsonl` 追加一条 `{ts, user, skill, chatId}`。统计刻意不基于 session：session 是 Pi 内部格式、7 天清理、话题群 session 多人共享无法按人归因；独立事件流可长期留存并按「人 × 技能 × 时间」聚合（实现见 `src/stats/`）。消费端有三处：飞书内 `query_skill_usage` 工具（自然语言查询，按会话注入调用者身份）、本地 `/stats` 可视化页面（按日/月/年分组、用户筛选、技能隐藏、月份 × 用户 × 技能明细表）、`GET /api/stats/events`。用户展示名按英文名 > 中文名 > Open ID 从用户缓存解析。

### 定时任务

`ScheduleService`（`src/schedule/service.ts`，croner 调度）管理持久化的定时任务。

**任务身份**：创建时生成唯一 id（时间戳_随机数，持久化于 `data/schedules.json`），调度、会话、历史全部挂在这张 id 上——判断"是否同一个任务"只看 id，与任务名/cron/内容无关；改名或改 cron 不换身份，删除重建则是新任务（历史从零开始）。

**专属会话与上下文**：每次触发以**创建者身份**在任务专属会话（conversationId = `{创建人}-schedule:{任务ID}`，同样拥有独立会话文件夹）中执行，输出以卡片推回创建时的会话（task.chatId）：

- 历史按触发累积——第 N 次执行时 AI 能看到之前 N-1 次的指令与结果（支持"接着上次进度继续"类任务）；文件 mtime 随触发刷新，持续触发的任务不会被保留期清理；
- **prompt 必须自包含**：首次触发时专属会话是空的，创建者那句话就是 AI 唯一能看到的指令。`schedule_manager` 工具已在描述中要求创建时把上下文固化进 prompt（写明做什么/对象/范围/格式），并对过短指令（<15 字）拒绝创建并给出示例；

**权限**：调度本身不做权限判断，判定发生在**执行中的每一次工具调用**——以创建者身份过 ToolGuard 漏斗（deny 规则 → 读范围/bash 名单/写入范围/tools 名单 → 智能体审核 → 授权卡），创建者权限之外的事任务做不了。无人值守时若弹授权卡，发往 task.chatId，5 分钟无人处理按拒绝（fail-safe），不阻塞调度器。

**持久化与创建入口**：任务持久化在 `data/schedules.json`，重启自动恢复调度；创建/修改当前通过编辑该文件完成（`addTask`/`removeTask` 接口已就绪，对话创建入口尚未接通——接通时需限定创建权限并落实"上下文固化"）。

## Agent 运行时

`FeishuPiRuntime`（`src/runtime/feishu-pi-runtime.ts`）通过 Pi 公开 SDK 创建 `AgentSession`：

1. `SessionManager.open/create` 恢复或新建 Pi 会话。一个会话对应磁盘上一个专属文件夹 `data/sessions/{会话 ID}/`（ID 中文件系统非法字符替换为 `_`）：新建会话的 sessionDir 指向该文件夹，续聊传入同目录——Pi 内部 /new、分支产生的新 jsonl 也落在会话文件夹内，附件则在其 `files/` 子目录；
2. `getModel`（`@earendil-works/pi-ai/compat`）按 provider/name/baseUrl 解析模型，支持 API 中转站；
3. `DefaultResourceLoader` 加载 `.agent/` 资源（技能全量开放，不做权限过滤）；
4. 自定义工具与内置工具按所属组策略的 `tools` 名单注册；
5. 注入 `beforeToolCall` Guard 钩子（read 范围 + 策略 + 智能体 + 授权卡）。

`SessionWrapper` 把 Pi 的 `AgentSession` 适配成项目自己的 `FeishuPiSession` 接口，向上层只暴露文本事件、工具生命周期事件、prompt/abort/getStats，避免飞书层依赖 Pi 内部类型。事件映射：`message_update` → `assistant_text`；`tool_execution_*` → `tool_started/updated/finished`。

模型支持运行时切换：`/model` 卡片按钮 → `persistModelName()` 写回 `.env` + `setModelName()` 热切换，新会话立即生效。

## 回复层

`FeishuAgentBridge`（`src/feishu/agent-bridge.ts`）管理单次回复的完整生命周期：

```text
收到消息 → MessageStore.claim 去重 → 命中指令走指令流程（/model /perm /login /logout /help /new /stop /detail）
  → 用户消息加随机表情（处理中标记）
  → 创建 CardKit 卡片，正文显示 spinner 思考动画（200ms/帧，随机样式）
  → 订阅事件流：assistant_text 增量推卡；工具调用显示动画行
  → 结束后写统计小字（模型、上下文 token、费用、耗时、会话短别名；`FEISHU_SHOW_MODEL_STATS` 可关闭终态小字，工具过程动画不受影响）
  → complete / fail，移除表情
```

`CardKitStream`（`src/feishu/cardkit-stream.ts`）实现 CardKit Schema 2.0 官方流式流程：创建 streaming_mode 卡片实体 → PUT 全量文本（800ms 节流 + 写队列串行化）→ PATCH 关闭流式 → 写统计元素。处理了官方 10 分钟自动关流后的重开重试。`CardKitReply` 在正文超过 10000 字符时于代码围栏外的完整块边界分新卡续写（分卡与首卡同回复形态）。CardKit 未启用或初始化失败直接报错（无文本回退），错误经日志与失败卡提示用户。

回复形态按会话模式判定（`resolveReplyInThread`，`src/feishu/cardkit-reply.ts`）：话题群一律以话题形式回复（`reply_in_thread: true`，**含话题根消息**——根消息自身没有 threadId，若按"有无 threadId"判定，飞书会为回复另开一个新话题）；私聊与普通群普通回复，消息本身在线程内则回线程内。指令卡在话题群同样回帖到原话题。

**parts 模型与滚动回收**：回复正文以"段"为单位管理（`parts[]`：正文段 + 工具摘要段，`toolPartIndices` 记录工具段位置）。精简模式滚动回收——新正文段出现时，旧工具段与旧正文段一起置空，只留"最新正文段 + 其后的工具段"；新工具出现时上一个工具段就地置空（只留当前一个）。终态组装（`composeFinal`）：详细模式 join 全部段落；精简模式取**最后一个工具段之后**的正文段拼接（无则退回全部非工具段），不丢已见内容。精简模式下授权卡确认后自动撤回，详细模式保留结果卡。
     
**模型侧配套**：系统提示注入 FINAL_REPLY_RULE——"最后一次工具调用之后输出的内容才是最终答复"，要求模型每次工具调用后输出完整独立的结论（使用侧保证，否则终态不可读）。

## 一条消息的时序

```text
用户发送飞书消息
  → LarkTransport 接收 WS 事件，normalize 归一化
  → 过滤自身消息、查用户资料、构造 conversationId、下载附件
  → FeishuAgentBridge：claim 去重
  → 指令消息：CommandRegistry 匹配，走指令流程（不进 Agent）
  → 普通消息：随机表情 + 建卡片 + spinner
  → ConversationManager 排队该会话（新消息可 abort 在途请求）
  → FeishuPiRuntime 调 Pi Session（工具调用经策略判定与授权）
  → assistant 文本 / 工具事件流回传 Bridge
  → CardKitStream 流式更新卡片
  → 统计小字收尾，移除表情
```

Agent 处理失败时，Bridge 将卡片更新为失败提示并记录日志；消息状态落 `messages.json` 供去重与卡住检测。

## 用户身份授权

> 完整机制与多用户并行登录方案见 [用户认证](user-auth.md)。

`UserAuthService`（`src/feishu/user-auth.ts`）实现 OAuth 2.0 Device Authorization Grant（RFC 8628），让聊天用户把"飞书用户身份"授权给机器人，用于应用身份做不到的"我的视角"能力（搜人、个人日历/文档等）：

> **身份分界**：用户资料查询使用**管理员**的 user token（管理员 `/login` 一次即可，数据范围 = 其组织架构可见范围）；而某个用户的 user token 仅用于以该用户本人身份执行操作，按 openId 隔离，不替代他人授权。两种 user token 各司其职，应用通讯录权限范围对它们都不生效。

- **`/login`**：向 `accounts.feishu.cn/oauth/v1/device_authorization` 发起授权，回复指引卡（授权链接 + 确认码）；后台按 RFC 8628 轮询 `open-apis/authen/v2/oauth/token`——pending 继续、slow_down 退避（+5s）、denied/expired 终止；结果经 `CommandResult.afterSend` 回传的 message_id 原地更新到指引卡，不阻塞指令回复。
- **token 生命周期**：按 openId 落盘 `data/user-tokens.json`，device_code 与发起者绑定（不接收"代他人授权"）；对外统一走 `getUserAccessToken(openId)`——access token 临期（<30s）用 refresh token 静默换新，refresh 也失效则清档并引导重新 `/login`。`/logout` 清除本人记录。
- **scope 默认内置**（`contact:contact.base:readonly` 通讯录调用权限 + `contact:user.base:readonly` + `contact:user.department:readonly` + `contact:user.department_path:readonly` + `contact:department.base:readonly`，用户资料查询所需；`FEISHU_USER_AUTH_SCOPES` 可覆盖），免审权限经同意页自动开通（实测：未预开通的免审权限会在同意页自动列出并一键开通，无需后台预操作）；实际可访问数据 = 应用 scope ∩ 用户本人可见范围，且不绕过 Guard 的组策略闸门。
- 全程免 redirect_uri 与公网回调；HTTP 用全局 fetch 直连（规避 SDK axios 在 Node ESM 下的 https 兼容问题，与 dsh-lark-link 的实践一致）。发起端点未见于公开文档，与官方 lark-cli 行为核实一致，升级 SDK/CLI 后建议回归一次 `/login`。

## 配置与持久化

服务从环境变量读取全部配置（`.env`，`loadConfig`），`npm run config` 起本地 Web 配置页（仅绑定 127.0.0.1:3456）。配置分组：飞书凭据（`FEISHU_APP_ID/SECRET`）、负责人（`FEISHU_ADMIN`）、模型（`FEISHU_PI_MODEL_*`）、智能体审核（`FEISHU_GUARD_*`，可选）。工具权限规则在 `.agent/permissions.json`，不在 env。

`data/` 目录（统一会话文件夹布局：一个会话一个文件夹，历史与附件同住）：

| 路径 | 内容 | 清理策略 |
|------|------|---------|
| `data/sessions/{会话 ID}/` | 会话专属文件夹：Pi 会话 jsonl（`/new` 后的新一代同目录累积） | jsonl 按 mtime 保留 7 天 |
| `data/sessions/{会话 ID}/files/` | 该会话收到的文件附件（时间戳-原始文件名） | 按 mtime 保留 7 天；清空后的 files/ 与空壳会话文件夹自动移除 |
| `data/sessions/conversations.json` | conversationId → sessionFile 映射 | 不主动清理；指向已删除文件时由会话层容错（打开失败即新建会话） |
| `data/sessions/messages.json` | 消息处理状态（去重） | 保留 7 天；processing 超 1 小时视为卡住清理 |
| `data/sessions/topic-roots.json` | 话题根消息 ID | — |
| `data/sessions/images/` | 图片附件缓存（按 imageKey 平铺去重） | 保留 7 天 |
| `data/user-tokens.json` | 用户飞书身份 token（/login） | 不按期清理；refresh 失效时按用户清档 |
| `data/stats/skill-usage.jsonl` | 技能使用事件流（JSONL，只增不删） | 不清理，长期留存 |
| `data/schedules.json` | 定时任务表（cron + 指令 + 目标会话） | 不自动清理；删除靠对话管理或手动编辑 |
| `data/users/{appId}_users.json` | 用户资料缓存 | 空 1 天 / 有档案 3 天过期刷新 |

`DataCleaner` 启动时执行一次，之后每 24 小时清理（扫描会话文件夹内的 jsonl 与附件，并回收空目录；根目录平铺的旧布局 jsonl 同样纳入清理）。`.agent/` 目录存放用户定义的 Skills（Markdown）、Tools（TypeScript）和权限策略 `permissions.json`。

## 安全边界

- `bash`、`write`、`edit` 拥有 Node 进程自身权限；Guard 只做审核拦截，不做沙箱隔离。服务必须以低权限账号运行，且工作目录应是隔离目录。
- 飞书凭据仅通过环境变量提供，不写入代码或日志。
- 机器人自身消息在 `LarkTransport` 中过滤（启动时自动获取 Bot Open ID）。
- 用户的 read 调用按所属组 `read`/`skills` 范围判定，路径含 `..` 穿越串不参与 glob 匹配；判定与实际读取使用同一 cwd 基准。
- 授权卡服务端校验：唯一 approvalId + 一次性 token，点击者必须是负责人，跨会话转发点击无效；授权单次有效，不缓存。
- 权限判断在代码层执行，防提示词注入绕过；策略文件解析失败按最保守处理。

## 当前范围

已实现：飞书 WS 长连接（底层 WSClient + EventDispatcher）、消息去重与卡住恢复、按用户/话题隔离的会话管理与增量持久化、Pi Session 复用与重启恢复、统一权限策略（common/admin/用户组，Skills 全量开放、工具/命令/读写范围按组过滤与判定）、ToolGuard（deny 第 0 层 → 策略 → 智能体综合判断 → 授权卡，另有系统提示密钥安全规则约束输出脱敏）、选项卡提问（ask_user_question 内置交互工具：向提问对象本人发选择卡，点选/超时后把结果交回模型，调用者身份由 runtime 派发时注入 `_caller`）、CardKit 2.0 流式卡片、图片与文件附件（统一会话文件夹存储 + 附件过期清理）、机器人指令（/model /perm /login /logout /help /new /stop /detail）、用户飞书身份授权（Device Flow + 静默刷新）、话题群回复形态修正（一律回原话题）、模型热切换、统计小字、详细/精简模式、技能使用统计（事件流 + 飞书查询 + 本地可视化页面 + 月度明细）、定时任务（cron 调度 + 持久化恢复 + 结果推送）、优雅退出（SIGINT/SIGTERM/SIGBREAK）、数据自动清理、TypeScript 类型检查与 Vitest 测试。

未实现：长期记忆注入、飞书业务工具（文档/多维表格/日历/审批，用户身份 token 层已就绪可复用）、模型侧用户身份注入与技能分支、状态卡片样式扩展、扫码一键建应用部署引导（候选，见路线图）。

详见 [开发路线](../ROADMAP.md)。
