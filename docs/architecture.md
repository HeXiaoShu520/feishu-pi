# feishu-pi 架构设计

## 目标与定位

feishu-pi 是深度集成飞书人员身份、会话和权限的 Agent 应用平台。Pi 提供 Agent loop、模型适配、Session 和编码工具；本工程负责飞书消息、按人或群的会话管理，以及按人和技能的工具权限控制。

当前先解决四个核心问题：建立统一的飞书上下文；会话按人或群隔离；不同人员和部门获得不同的技能与工具权限；同一技能根据上下文进入不同子分支。管理员可以使用 `read`、`write`、`edit`、`bash` 等工具，其他人员按权限配置使用。租户组织关系、工具调用审计和飞书业务资源权限暂不纳入当前范围。

## 选型边界

Pi 是本工程的运行时底座。feishu-pi 仅使用其公开 SDK，不 fork、复制或修改 Pi 核心；因此可以复用成熟的 Session、模型流、Agent tool loop 和 `read`、`write`、`edit`、`bash`。

OpenClaw 是覆盖多渠道、Gateway、工具生态和运行管理的完整 Agent 产品。feishu-pi 借鉴其会话路由和渠道适配的边界设计，但不引入多渠道、CLI/TUI、MCP 编排和产品级运行管理，因为这些能力不服务当前单一飞书机器人的闭环。

Hermes 强调长期记忆、经验沉淀和自我改进。feishu-pi 借鉴其记忆应独立于短期上下文、可审计并按价值沉淀的原则，但不会一开始引入复杂检索或向量数据库；记忆能力将按飞书业务逐步接入。

这条路线避免两个极端：从零实现 Agent runtime 会重复 Pi 已解决的问题；直接采用 OpenClaw 或 Hermes 则会带来单一飞书场景不需要的依赖、部署复杂度和响应开销。

## 分层

```text
飞书消息
  ↓
飞书上下文层（用户 Open ID / 英文名 / 部门 / 群 ID）
  ↓
会话层（按人或群隔离）
  ↓
技能与权限层（人员 / 部门 / 技能 / 工具白名单）
  ↓
Agent 应用层（按上下文选择技能分支）
  ↓
Pi Runtime（Agent loop / Session / 模型 / read-write-edit-bash）
```

当前代码已落地的是飞书消息层、基础会话层、Pi Runtime 和 `FeishuContext` 骨架；英文名与部门信息的通讯录解析、按人员和部门配置技能权限，以及技能分支选择，是下一步核心工作。

建议的基础上下文：

```ts
interface FeishuContext {
  userOpenId: string;
  userName?: string;
  departmentIds?: string[];
  chatId: string;
  threadId?: string;
  conversationId: string;
}
```

所有技能都通过该上下文获取调用者信息，不自行解析飞书原始事件。

### 飞书层

`LarkTransport` 使用飞书官方 Node SDK 建立 WebSocket 长连接，接收标准化消息并发送引用回复。连接由官方 SDK 自动重连；应用层设置 15 秒握手超时、30 秒心跳超时，并记录重连和错误事件。`connect()` 只注册一次消息处理器且可重复调用。每条新用户消息先通过项目本地 `lark-cli contact +get-user --as bot` 查询英文名和部门 ID，并保存到 `memory/users/`；CLI 缺失、未登录或查询失败时，在原会话反馈明确错误。回复从“正在处理…”占位文本开始，后续通过编辑同一条飞书消息展示 Agent 输出。

`FeishuAgentBridge` 负责把飞书的 `chatId`、`threadId` 和文本转换为运行时消息。它持有单次回复的 `ThrottledReply`，将高频文本更新按 80ms 合并，并保证飞书写入按顺序执行。

### 会话层

`ConversationManager` 用下列规则生成会话键：

```text
chat:<chatId>
<chatId>:thread:<threadId>
```

同一会话复用同一个 Pi Session，并通过 Promise 队列保证消息顺序。不同会话不共享队列，可以并行处理。

### Agent 运行时

`FeishuPiRuntime` 通过 Pi 公开 SDK 创建 `AgentSession`。默认可用工具为：

```text
read / write / edit / bash
```

业务 Function Calling 通过构造器的 `FeishuPiTool[]` 注入，并和内置工具一起交给 Pi。运行时向上层只暴露文本事件、提示词和等待接口，避免飞书层依赖 Pi 的内部 Session 类型。

## 一条消息的时序

```text
用户发送飞书消息
  → LarkTransport 接收 WebSocket 事件
  → FeishuAgentBridge 创建引用回复和会话 ID
  → ConversationManager 排队执行该会话
  → FeishuPiRuntime 调用 Pi Session
  → Pi 执行模型推理与工具调用
  → assistant 文本事件返回 Bridge
  → ThrottledReply 合并更新
  → LarkTransport 编辑飞书回复
```

Agent 处理失败时，Bridge 会将占位回复更新为“处理失败，请稍后重试。”，然后将异常继续抛出，保留 SDK 和宿主进程的错误可见性。

## 配置与持久化

服务从环境变量读取飞书凭据、模型 Provider、工作目录和 Pi Session 目录。Pi 的 Session 文件由 `SessionManager` 创建；当前进程内按会话键复用 Session。

会话键到 Session 文件的映射保存在 `FEISHU_PI_SESSION_DIR/conversations.json`，服务重启后会尝试恢复原 Pi Session；会话内容继续使用 Pi 原生 Session 格式，Markdown 只用于后续的长期记忆，不作为会话历史格式。消息处理状态保存在同目录的 `messages.json`，以 `messageId` 避免重复执行 Agent。

## 安全边界

- `bash`、`write`、`edit` 拥有 Node 进程自身权限。
- 服务必须以低权限账号运行，且 `FEISHU_PI_CWD` 必须是隔离工作目录。
- 飞书凭据仅通过环境变量提供，不写入代码或日志。
- 机器人自身消息在 `LarkTransport` 中通过可选的 `FEISHU_BOT_OPEN_ID` 过滤。

## 当前范围

已实现：飞书 WebSocket、Pi Session、会话内串行、会话映射持久化、消息去重、内置编码工具、业务工具注入、文本回复更新、回复节流、TypeScript 类型检查和基础单元测试（3 个测试文件、6 个测试用例）。

未实现：CardKit producer 式流、图片/文件/音频解析、长期记忆注入、业务飞书工具、完整优雅关闭和真实飞书环境验收。
