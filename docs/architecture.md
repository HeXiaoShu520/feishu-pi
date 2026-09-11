# feishu-pi 架构设计

## 目标与定位

feishu-pi 是深度集成飞书人员身份、会话和权限的 Agent 应用平台。Pi 提供 Agent loop、模型适配、Session 和编码工具；本工程负责飞书消息、按人或群的会话管理，以及按身份的权限控制与定时任务。

核心能力及当前状态：统一飞书上下文（已落地）、会话按人或话题隔离（已落地）、两档身份的权限管控（已落地：管理员/用户，策略文件统一配置）、工具调用审核与人工授权（已落地：策略 → 智能体综合判断 → 授权卡）、定时任务（已落地：cron 调度 + 结果推送）、技能使用统计（已落地）。租户组织关系、飞书业务资源权限暂不纳入当前范围。

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
技能与权限层（统一策略文件：工具/命令/读写范围按身份过滤 + ToolGuard：策略 → 智能体 → 授权卡）
  ↓
Agent 运行时（Pi AgentSession + 内置工具 + .agent 自定义工具 + 定时任务）
  ↓
回复层（FeishuAgentBridge → CardKit 2.0 流式卡片 + spinner / 表情反馈 + 统计小字）
```

所有技能都通过 `FeishuContext`（`src/context/types.ts`）获取调用者信息，不自行解析飞书原始事件：

```ts
interface FeishuContext {
  userOpenId: string;      // 用户 Open ID
  userName: string;        // 中文名 > 英文名 > Open ID
  departmentNames?: string[]; // 部门中文名列表
  chatId: string;          // 会话 ID
  threadId?: string;       // 话题 ID
  conversationId: string;  // 完整会话标识
  isAdmin?: boolean;       // 是否管理员
}
```

`FeishuContext` 用于身份组判定（owner 成员按 openId/姓名匹配）、权限过滤、会话命名与日志，**尚未注入到模型提示词**（AI 在对话中感知不到调用者身份，「同一技能/工具内部按身份分支」待实现）。

## 飞书传输层

`LarkTransport`（`src/feishu/lark-transport.ts`）使用飞书官方 Node SDK 的**底层** `WSClient + EventDispatcher` 建立长连接，而非高层 `LarkChannel` 封装。原因有二：卡片回调 handler 的返回值需要原样进入 ACK 数据体（与 Go 官方 SDK 行为一致，LarkChannel 会丢弃）；LarkChannel 的去重逻辑会静默吞掉事件。连接由官方 SDK 自动重连；应用层设置 15 秒握手超时、30 秒 ping 超时。

消息处理管线（`dispatchMessage`）：

1. 过滤机器人自己的消息；
2. 查询用户资料（`LarkCli` 三步策略，见下）；
3. 构造 `conversationId`（规则见会话层）；
4. 下载图片/文件附件，把本地路径写入消息文本供 Agent 直接 `read`；
5. 清洗 @机器人 标记；
6. 判定 isAdmin 后交给上层 handler（fire-and-forget，不阻塞 SDK 事件循环）。

`card.action.trigger` 卡片回调路由：授权卡（`tool_approval` / `forward_approval`）转交 PermissionBroker；模型切换按钮校验管理员后写回 `.env` 并触发热切换。

用户资料查询与缓存（`LarkCli`，`src/feishu/lark-cli.ts`）：优先 contact API，降级到群成员列表分页查找，最后 spawn 外部 `lark-cli contact +search-user` 补充部门/英文名；结果缓存到 `data/users/{appId}_users.json`。三级查询全部失败时降级资料（仅 openId，字段允许为空）**同样入库**，避免每条消息都执行完整查询；缓存 TTL 双档：空档案 1 天、有档案 3 天，过期重查失败时保留既有资料不降级。

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

### 统一权限策略（一个文件，两个身份组）

全部权限集中在 `.agent/permissions.json`（`src/permission/policy.ts` 解析）。两个身份组：owner（负责人，FEISHU_ADMIN 亦自动属于）与 user（其他所有人），每组字段：`members`（成员）、`tools`（可调用工具）、`bash`（可执行命令，`cmd:*` 前缀）、`read` / `write`（路径 glob）、`skills`（可见技能）。另有 `common` 通用层：所有人自动获得的能力（如读技能目录）。

生效范围 = common ∪ 所属组；组文件 mtime 热重载，新会话生效；策略文件缺失/写坏按保守默认处理（user 仅技能目录可读、无工具）。

**工具与技能零改造**：说明书放在 `.agent/skills/*.md`，不含任何权限信息，约束全部由策略文件表达、由过滤层执行。

| 身份 | Custom Tools | 内置工具 | 可读范围 |
|------|-------------|---------|---------|
| owner | 策略 tools 名单（默认 `*`） | 名单内的 read/bash/write/edit | 策略 read 范围（默认 `**`） |
| user | 策略 tools 名单 | 名单内的 bash / read | 策略 read 范围（默认技能目录） |

### ToolGuard（策略 → 智能体 → 授权卡）

所有身份（含负责人）的每次工具调用都经过 `beforeToolCall` 钩子（`src/guard/`）：

```text
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

`ScheduleService`（`src/schedule/service.ts`，croner 调度）管理持久化的定时任务。负责人对 AI 说"每天早上 9 点给我播报 xxx"，AI 调用 `schedule_manager` 工具（仅 owner 组注册）解析为 cron + 指令并创建；到点后以**创建者身份**在独立会话（`{创建人}-schedule:{任务ID}`）中执行，输出以卡片推回创建时的会话；执行失败记录 lastStatus 并在列表可见。任务持久化在 `data/schedules.json`，重启自动恢复调度。

## Agent 运行时

`FeishuPiRuntime`（`src/runtime/feishu-pi-runtime.ts`）通过 Pi 公开 SDK 创建 `AgentSession`：

1. `SessionManager.open/create` 恢复或新建 Pi 会话（文件为 `data/sessions/*.jsonl`）；
2. `getModel`（`@earendil-works/pi-ai/compat`）按 provider/name/baseUrl 解析模型，支持 API 中转站；
3. `DefaultResourceLoader` 加载 `.agent/` 资源（技能全量开放，不做权限过滤）；
4. 自定义工具与内置工具按所属组策略的 `tools` 名单注册；
5. 注入 `beforeToolCall` Guard 钩子（read 范围 + 策略 + 智能体 + 授权卡）。

`SessionWrapper` 把 Pi 的 `AgentSession` 适配成项目自己的 `FeishuPiSession` 接口，向上层只暴露文本事件、工具生命周期事件、prompt/abort/getStats，避免飞书层依赖 Pi 内部类型。事件映射：`message_update` → `assistant_text`；`tool_execution_*` → `tool_started/updated/finished`。

模型支持运行时切换：`/model` 卡片按钮 → `persistModelName()` 写回 `.env` + `setModelName()` 热切换，新会话立即生效。

## 回复层

`FeishuAgentBridge`（`src/feishu/agent-bridge.ts`）管理单次回复的完整生命周期：

```text
收到消息 → MessageStore.claim 去重 → 命中指令走指令流程（/model /perm /help /new /stop /detail）
  → 用户消息加随机表情（处理中标记）
  → 创建 CardKit 卡片，正文显示 spinner 思考动画（200ms/帧，随机样式）
  → 订阅事件流：assistant_text 增量推卡；工具调用显示动画行
  → 结束后写统计小字（模型、上下文 token、费用、耗时、会话短别名）
  → complete / fail，移除表情
```

`CardKitStream`（`src/feishu/cardkit-stream.ts`）实现 CardKit Schema 2.0 官方流式流程：创建 streaming_mode 卡片实体 → PUT 全量文本（800ms 节流 + 写队列串行化）→ PATCH 关闭流式 → 写统计元素。处理了官方 10 分钟自动关流后的重开重试；工具行等临时文本不进入最终内容。`CardKitReply` 在正文超过 10000 字符时于代码围栏外的完整块边界分新卡续写；CardKit 异常时降级普通文本消息。

详细/精简模式（`/detail`，按会话记忆）：精简模式工具调用过程临时显示后清除；详细模式永久保留在正文中，便于审查。精简模式下授权卡确认后自动撤回，详细模式保留结果卡。

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

## 配置与持久化

服务从环境变量读取全部配置（`.env`，`loadConfig`），`npm run config` 起本地 Web 配置页（仅绑定 127.0.0.1:3456）。配置分组：飞书凭据（`FEISHU_APP_ID/SECRET`）、负责人（`FEISHU_ADMIN`）、模型（`FEISHU_PI_MODEL_*`）、智能体审核（`FEISHU_GUARD_*`，可选）、授权超时（`FEISHU_APPROVAL_TIMEOUT_MS`）。工具权限规则在 `.agent/permissions.json`，不在 env。

`data/` 目录：

| 路径 | 内容 | 清理策略 |
|------|------|---------|
| `data/sessions/*.jsonl` | Pi 会话文件（原生格式） | 保留 7 天 |
| `data/sessions/conversations.json` | conversationId → sessionFile 映射 | 不主动清理；指向已删除文件时由会话层容错（打开失败即新建会话） |
| `data/sessions/messages.json` | 消息处理状态（去重） | 保留 7 天；processing 超 1 小时视为卡住清理 |
| `data/sessions/topic-roots.json` | 话题根消息 ID | — |
| `data/sessions/images/` | 图片附件缓存 | 保留 7 天 |
| `data/sessions/files/` | 文件附件缓存 | 当前不在清理范围（见已知缺口） |
| `data/stats/skill-usage.jsonl` | 技能使用事件流（JSONL，只增不删） | 不清理，长期留存 |
| `data/schedules.json` | 定时任务表（cron + 指令 + 目标会话） | 不自动清理；删除靠对话管理或手动编辑 |
| `data/users/{appId}_users.json` | 用户资料缓存 | 空 1 天 / 有档案 3 天过期刷新 |

`DataCleaner` 启动时执行一次，之后每 24 小时清理。`.agent/` 目录存放用户定义的 Skills（Markdown）、Tools（TypeScript）和权限策略 `permissions.json`。

## 安全边界

- `bash`、`write`、`edit` 拥有 Node 进程自身权限；Guard 只做审核拦截，不做沙箱隔离。服务必须以低权限账号运行，且工作目录应是隔离目录。
- 飞书凭据仅通过环境变量提供，不写入代码或日志。
- 机器人自身消息在 `LarkTransport` 中过滤（启动时自动获取 Bot Open ID）。
- 用户的 read 调用按所属组 `read`/`skills` 范围判定，路径含 `..` 穿越串不参与 glob 匹配；判定与实际读取使用同一 cwd 基准。
- 授权卡服务端校验：唯一 approvalId + 一次性 token，点击者必须是负责人，跨会话转发点击无效；授权单次有效，不缓存。
- 权限判断在代码层执行，防提示词注入绕过；策略文件解析失败按最保守处理。

## 当前范围

已实现：飞书 WS 长连接（底层 WSClient + EventDispatcher）、消息去重与卡住恢复、按用户/话题隔离的会话管理与增量持久化、Pi Session 复用与重启恢复、统一权限策略（common/owner/user，Skills 全量开放、工具/命令/读写范围按组过滤与判定）、ToolGuard（策略 → 智能体综合判断 → 授权卡）、CardKit 2.0 流式卡片、图片与文件附件、机器人指令（/model /perm /help /new /stop /detail）、模型热切换、统计小字、详细/精简模式、技能使用统计（事件流 + 飞书查询 + 本地可视化页面 + 月度明细）、定时任务（cron 调度 + 持久化恢复 + 结果推送）、优雅退出（SIGINT/SIGTERM/SIGBREAK）、数据自动清理、TypeScript 类型检查与 Vitest 测试。

未实现：长期记忆注入、飞书业务工具（文档/多维表格/日历/审批）、模型侧用户身份注入与技能分支、状态卡片样式扩展。已知缺口：`data/sessions/files/` 文件缓存不在 DataCleaner 清理范围内，长期运行会累积。

详见 [开发路线](../ROADMAP.md)。
