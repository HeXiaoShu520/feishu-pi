# feishu-pi

feishu-pi 是一个基于 [Pi](https://github.com/earendil-works/pi) 的飞书 Agent 应用平台。它深度集成飞书人员身份、会话和权限，为不同的人或群提供不同的 Agent 能力。

架构与选型见 [架构设计](docs/architecture.md)，用户身份授权见 [用户认证](docs/user-auth.md)，阶段计划见 [开发路线](ROADMAP.md)。

## 核心特性

- ✅ **CardKit 流式卡片** - 实时显示 Agent 输出（打字机效果 + Markdown 渲染）
- ✅ **随机动画表情** - 思考时随机选择 7 种 spinner 动画（braille、halfcircle、quarter、cross、triangle、square、braille2）+ 随机前缀，每帧 200ms 循环
- ✅ **技能使用统计** - 每次读取技能文件自动记录事件（独立于 session 的追加式事件流，长期留存）；飞书内自然语言查询（如「查看技能使用情况」），本地浏览器提供可视化界面 `/stats`（按日/月/年分组、用户筛选、技能隐藏）；用户展示名按 英文名 > 中文名 > Open ID 解析
- ✅ **图片附件支持** - 发送图片让 Agent 识别和分析（支持视觉模型）
- ✅ **文件附件支持** - file/audio/video 附件自动下载到会话文件夹并把路径交给 Agent 处理
- ✅ **用户身份授权** - `/login` 通过 Device Flow 完成用户授权（免公网回调、免重定向 URL 白名单）；user_access_token 按 openId 隔离存储、静默续期，支撑"我的视角"能力
- ✅ **会话隔离** - 按 `chatId` 和 `threadId` 独立会话上下文
- ✅ **消息去重** - 防止重复处理同一消息
- ✅ **自动重连** - WebSocket 断线自动恢复
- ✅ **飞书用户上下文** - 自动查询并缓存用户信息（中文名、英文名、部门名；经管理员 `/login` 授权的用户身份查询），供所有技能和 Function Calling 直接使用
- ✅ **基于组的权限控制** - admin 和任意自定义组（group1、vip…），规则扁平分组、动态热重载
- ✅ **工具调用 Guard** - 指令白名单（正则）+ 大模型审核 + 管理员授权卡（单次确认，支持转发到管理员私聊），高危调用默认弹卡
- ✅ **Skills 支持** - 基于 Pi-agent 的技能系统，支持权限配置
- ✅ **Function Calling** - 自定义工具注册，支持权限控制
- ✅ **受限文件访问** - 非管理员只能读取技能文件，无法访问敏感数据
- ✅ **内置工具** - 管理员可使用 `read`、`write`、`edit`、`bash` 工具
- ✅ **机器人指令** - `/model` 查看/切换模型、`/help` 查看帮助、`/new` 清空对话、`/stop` 中断响应、`/detail` 切换详细/精简模式、`/login` `/logout` 用户身份授权
- ✅ **卡片统计小字** - 回复完成后显示模型、上下文 token（含本次新增）、费用、耗时与会话短别名；工具调用期间显示动画

## 飞书深度定制：用户上下文机制

这是 feishu-pi 区别于通用 Agent 平台的核心基础设施。每条飞书消息到达时，系统会自动：

1. **查询用户信息** - 通过飞书 SDK API 获取用户的中文名、英文名（按会话模式选通道）
2. **智能降级** - 如果用户不在应用可见范围（如外部群成员），自动从群成员列表获取
3. **本地缓存** - 缓存 3 天，减少 API 调用，加快响应速度
4. **注入上下文** - 将用户信息注入到每个请求的 `context` 中

**数据结构：**

```typescript
interface FeishuContext {
  userOpenId: string;         // 用户 Open ID
  userName?: string;          // 中文名 > 英文名 > Open ID
  departmentNames?: string[]; // 部门中文名列表
  chatId: string;             // 会话 ID
  threadId?: string;          // 话题 ID
  chatMode?: "p2p" | "group" | "topic"; // 会话模式（传输层查询并缓存）
  conversationId: string;     // 完整会话标识
  isAdmin?: boolean;          // 是否为管理员
}
```

**为什么这很重要：**

- **技能开发零成本** - 所有技能和 Function Calling 直接读取 `context.userName`、`context.departmentNames`，无需自己调用飞书 API
- **权限控制** - 根据用户身份（openId / 姓名对应身份组）动态控制技能可用性和工具权限
- **个性化响应** - Agent 可以根据用户身份提供定制化的回答和建议
- **审计追踪** - 每次操作都有明确的用户身份，便于日志记录和问题排查

**存储位置：** `data/users/{appId}_users.json`

**查询策略（管理员身份单通道）：**

以管理员 `/login` 授权的 user token 调用 contact API 一次拿全中文名、英文名、部门名（数据范围 = 管理员的组织架构可见范围，默认全组织）。查询失败返回最小信息（Open ID，其余字段允许为空）且**不写入缓存**——下一条消息自动重试，重查失败时保留已查到的旧资料不降级。技能内自行判断空字段做兜底展示。

## 会话模型

会话的隔离与共享规则由消息所在的飞书会话类型决定（`getChatMode` 判定，结果按 chatId 缓存）：

| 场景 | 会话归属 | conversationId 格式 |
|------|---------|--------------------|
| 私聊 / 普通群 | **按用户隔离**——同一群里每个人独立上下文 | `{openId}-chat:{chatId}` 或 `{openId}-{chatId}:thread:{threadId}` |
| 话题群的话题 | **按话题共享**——话题内所有用户共用一个上下文，可以接力讨论 | `topic:{chatId}:{话题根消息ID}` |

**话题根的收敛规则：** 话题的第一条消息没有 threadId，此时用该消息自己的 messageId 作为话题键并落盘（`data/sessions/topic-roots.json`）；后续消息的 threadId 恰好就是这条根消息的 ID，自然收敛到同一会话。若根未确立前用户追加消息（比如首条还在处理时被打断），会从落盘中取回话题根，**不会裂成新会话**。

**增量持久化：** `conversationId → sessionFile` 的映射在 Pi 首次落盘（首个 `message_end` 事件）时就写入，不等整轮回复完成——响应中途被中断或进程退出，下次也能恢复到同一会话。

**回复形态：** 话题群内回复一律以话题形式（`reply_in_thread: true`）落进原话题——包括话题根消息（它自身没有 threadId，若按"有无 threadId"判定，飞书会为回复另开一个新话题）；私聊与普通群跟随消息自身形态：普通消息普通回复，消息本身在线程内则回线程内。

**会话数据存储（统一会话文件夹）：** 一个会话对应磁盘上一个专属文件夹 `data/sessions/{会话 ID}/`（ID 中的 `:` 等文件系统非法字符替换为 `_`），Pi 会话历史（jsonl）与用户发来的文件附件（`files/` 子目录）都落在里面；`conversationId → sessionFile` 的索引保留在 `data/sessions/conversations.json`，程序恢复会话以它为准。图片缓存不按会话分（内容寻址，`data/sessions/images/` 平铺去重）。

`/new` 在话题内被禁止（共享会话不允许单人清空），私聊和普通群可用。它只清记忆不清文件：`/new` 删除索引并在同一会话文件夹里开一个新的 jsonl，旧记录与附件都留在磁盘上，由 `data-cleaner` 按 7 天保留期统一清理（会话文件、附件、图片缓存、消息状态，清空的会话文件夹自动移除）。

## 我们最终要实现什么

构建一个可靠、可维护且响应快的飞书原生 Agent：

```text
飞书消息（文本 + 图片）
  → 会话路由与上下文恢复
  → Pi Agent + 内置编码工具 + 飞书业务工具
  → 长期记忆与经验沉淀
  → CardKit 流式卡片回复
```

它需要具备连续多轮对话、业务 Function Calling、受控工作目录、会话持久化、轻量长期记忆，以及飞书文档、多维表格、日历、审批等业务能力。实现按真实需要逐项增加，不把产品无关的基础设施提前带入。

## 定位

feishu-pi 不是一个简单的飞书消息入口，而是深度集成飞书人员身份、会话和权限的 Agent 应用平台：

- **统一飞书上下文**：每次请求都携带用户 Open ID、英文名、部门和群会话信息，供所有技能读取。
- **按人或群管理会话**：使用用户 Open ID 或群 ID 作为会话隔离依据。
- **按人、部门和技能控制权限**：不同人员、部门可以拥有不同的技能和工具权限；管理员可以使用 `read`、`write`、`edit`、`bash` 等工具，普通用户按配置限制。
- **技能按上下文分支**：同一个技能可以根据用户部门、身份或会话类型进入不同的处理分支。
- **Pi 驱动**：复用成熟的 Agent loop、Session、Provider 适配及内置工具。
- **轻量可控**：先解决身份上下文、会话隔离、技能分支和工具权限，其他能力按实际需求增加。

## 为什么基于 Pi

Pi 已经提供 Agent 运行时中最难长期维护的部分：模型流式调用、工具循环、上下文与 Session、编码工具及 Provider 适配。feishu-pi 通过 Pi 的公开 SDK 组合这些能力，不 fork 也不修改 Pi 核心代码。

因此本工程只维护真正属于产品的部分：飞书连接、会话路由、回复生命周期、权限边界、记忆策略和业务 Function Calling。这样既避免重复实现 Agent loop，也避免被 Pi 的 CLI/TUI 产品形态绑住。

## 与 OpenClaw、Hermes 的区别

| 项目      | 主要定位                                                         | feishu-pi 的取舍                                                               |
| --------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Pi        | 通用 Agent Runtime 与编码 Agent 能力                             | 作为底座复用，不修改核心实现。                                                 |
| OpenClaw  | 多渠道 Gateway 型 Agent 产品，覆盖渠道、编排、工具生态和运行管理 | 借鉴会话路由与 Gateway 思路，但不引入多渠道、CLI、MCP 编排等当前无关能力。     |
| Hermes    | 强调长期记忆、经验沉淀和自我改进的 Agent 产品                    | 借鉴记忆分层与经验沉淀方法，但先使用轻量、可审计的文件化记忆，按业务需要演进。 |
| feishu-pi | 单一飞书渠道的轻量 Agent 后端                                    | 用 Pi 运行 Agent，以最少的自有代码实现飞书业务闭环。                           |

选择这条路线的原因是：直接使用 OpenClaw 或 Hermes 会把大量与单一飞书机器人无关的产品能力、依赖和运行复杂度带入系统；从零实现则要重新承担 Pi 已解决的 Agent runtime 问题。feishu-pi 取中间路线，复用 Pi 的稳定能力，只建设飞书产品确实需要的部分。

## 开始使用

### 0. 安装依赖

环境要求：Node.js 22+（类型定义基于 @types/node 22.x），包管理器为 npm。

```bash
git clone <repo-url>
cd mini-claw
npm install
```

> `npm install` 会自动执行 `postinstall` 脚本（`scripts/patch-pi-ai.js`），对 `node_modules/@earendil-works/pi-ai` 打补丁：移除 Anthropic 请求头中的 `anthropic-dangerous-direct-browser-access`，避免经 API 中转站调用时返回 403。重新安装依赖后补丁会自动重新应用，无需手动处理。

### 依赖补丁与升级注意

项目目前有 **1 个文件补丁 + 1 处历史行为补丁（已删除）**，升级依赖前扫一眼本节：

| 补丁 | 补的对象 | 原因 | 失效症状 | 何时可删 |
|------|---------|------|---------|---------|
| `scripts/patch-pi-ai.js`（postinstall，自动重放） | `@earendil-works/pi-ai` | 浏览器访问请求头导致 API 中转站 403 | 直连官方 API 时中转站不再 403，或改用官方直连 | pi-ai 上游移除该请求头 |
| ~~`patchCardAck()`（已删除）~~ | `@larksuiteoapi/node-sdk` LarkChannel | 卡片回调应答无数据体 + 去重静默吞事件 | — | 已于传输层切换到官方底层 `WSClient + EventDispatcher` 后删除（详见 `git log` 中"传输层切换"提交） |

**传输层实现说明**：`src/feishu/lark-transport.ts` 使用官方**底层** `WSClient + EventDispatcher`（而非 LarkChannel 高层封装）——卡片回调 handler 的返回值会原样进 ACK 数据体（与 Go 官方 SDK 行为一致），消息归一化使用官方导出的 `normalize()`。升级 node-sdk 版本后建议快速回归一次：收发消息、文件附件、授权卡点击、/model 切换。

**版本策略**：`@larksuiteoapi/node-sdk` 使用精确锁版（无 `^`），升级需手动改版本号并回归；`@earendil-works/*`（Pi 系）跟随上游 minor 版本。

### 1. 配置飞书应用权限

在 [飞书开放平台](https://open.feishu.cn/) 开发者后台配置以下权限：

**必需权限：**
- `im:message` - 获取与发送单聊、群组消息（含撤回机器人自己的消息）
- `im:message.group_at_msg` - 接收群聊中 @机器人 消息事件
- `im:message.p2p_msg` - 接收用户单聊消息事件
- `im:message.reaction:write` - 添加/删除表情回复（思考动画 emoji）
- 机器人通讯录权限：用户资料查询已改走管理员身份（见第 2 节），机器人侧无需额外通讯录权限

**可选权限（用于图片功能）：**
- `im:resource` - 获取消息中的资源文件（图片、文件附件）

**可选权限（用于用户身份授权）：**
- scope 已内置默认以下免审权限（**未预开通时，`/login` 同意页会自动列出并一键开通**，无需后台操作）：
  - `contact:contact.base:readonly` - 通讯录调用权限（contact API 的接口准入）
  - `contact:user.base:readonly` - 用户基本信息（中文名、英文名）
  - `contact:user.department:readonly` - 用户组织架构信息（department_ids）
  - `contact:user.department_path:readonly` - 成员所在部门路径（含部门名，一次调用直接带出）
  - `contact:department.base:readonly` - 部门基本信息（部门 ID 换部门名）
- 用户通过 `/login` 完成授权（Device Flow，无需配置重定向 URL 白名单）；如需自定义申请的权限，用 `FEISHU_USER_AUTH_SCOPES` 覆盖

> **三种身份通道，各司其职、互不替代：**
> - **机器人身份**（tenant token）：收发消息、群操作等应用能力，数据范围 = 应用的通讯录权限范围；
> - **管理员 user token**（管理员 `/login` 一次）：用户资料查询通道（中文名/英文名/部门名），数据范围 = 管理员的组织架构可见范围（默认全组织）；
> - **普通用户 user token**（各自 `/login` 或增量授权）：用于"以该用户本人身份"执行操作（他的视角、他的数据），按 openId 隔离，不替代他人。

**事件订阅：**
- 订阅方式：选择「使用长连接接收事件/回调」
- 订阅事件：`im.message.receive_v1` - 接收消息
- 卡片回调：`card.action.trigger` - 授权卡按钮点击、模型切换等卡片交互（长连接模式下随事件回调自动接管，无需额外配置公网回调地址）

**应用可用范围：**
- 设置可使用该应用的部门或成员范围
- 范围越大，能查询到的用户信息越完整

### 2. 用户资料查询说明（管理员身份）

用户资料（中文名、英文名、部门名）统一使用**管理员的用户身份**查询：管理员发一次 `/login`（Device Flow）完成授权后，机器人持其 user_access_token 调用 contact API。数据范围 = 管理员的**组织架构可见范围**（管理员默认全组织可见），**与应用的通讯录权限范围无关**；应用可用范围外的内部成员同样可查。管理员查不到的**跨租户外部用户**（不在本组织通讯录）→ 自动降级用**群成员名单**（机器人身份，分页实时查找）拿中文名。

- 前置：开发者后台为应用开通上述五个权限并发布版本（scope 已内置，无需配置环境变量）；管理员发 `/login` 完成授权
- 查询失败（管理员未登录/接口异常/名单也没有）写入**冷却档案**（仅 openId，保留旧资料），1 天内不再重试，冷却期满自动重查；成功档案缓存 3 天
- 无需为机器人开通任何通讯录权限，也无需任何外部 CLI 工具

> ℹ️ 历史版本曾通过外部 `lark-cli` 命令行补充部门信息，该依赖已移除；部门数据现由 contact API + 部门权限获取。

> **数据权限的三层模型**：API 权限（scope，开发者后台开通）管"接口能不能调"；应用身份（机器人）的数据范围 = 应用的**通讯录权限范围**（数据权限页配置）；用户身份（`/login` 的 user token）的数据范围 = 该用户的**组织架构可见范围**（管理后台配置），与应用通讯录范围无关。

> 💡 **计划中（暂未实现）**：参考同类项目的"扫码一键建应用"引导——部署时扫一次二维码自动创建飞书应用、配置事件订阅与权限，并把 App ID/Secret 回填 `.env`，实现新部署 30 秒起步。目前仍需在开发者后台手动创建应用并填写配置。

### 3. 配置应用

**方式一：使用配置界面（推荐）**

```bash
npm run config
```

在浏览器打开 `http://localhost:3456`，通过 Web 界面配置：
- 飞书应用：App ID、App Secret、管理员标识
- AI 模型：Provider（Anthropic/OpenAI）、Model Name、Base URL
- API Key：统一的 API Key 配置

配置保存后会直接写入 `.env` 文件。

**方式二：手动编辑 .env 文件**

创建 `.env` 文件并填写以下必需配置：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_ADMIN=管理员标识

# 模型配置
FEISHU_PI_MODEL_PROVIDER=anthropic
FEISHU_PI_MODEL_NAME=claude-sonnet-4-6
FEISHU_PI_MODEL_BASE_URL=https://api.anthropic.com

# API Key
FEISHU_PI_MODEL_API_KEY=sk-ant-xxx

# 系统提示词（可选）
FEISHU_PI_SYSTEM_PROMPT=你是一个专业的编程助手，擅长代码分析和问题解决。

# 团队成员（可选，用于权限控制）
（已废弃——两档身份下没有成员名单，FEISHU_ADMIN 即全部配置）
```

### 4. 启动服务

```bash
npm install
npm start
```

启动前至少配置：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_ADMIN=管理员标识
```

**管理员配置说明：**
- `FEISHU_ADMIN`：机器人管理员标识，支持以下格式：
  - Open ID：`ou_xxxxxxxx`（直接使用）
  - 中文姓名：`张三`（启动时自动查询转换为 Open ID）
  - 英文姓名：`John`（启动时自动查询转换为 Open ID）
  - 邮箱：`admin@example.com`（启动时自动查询转换为 Open ID）
- 管理员权限：部分敏感指令只有管理员可执行
- 启动时会自动解析并输出管理员 Open ID

用户信息会在首次聊天时自动查询并缓存到 `data/users/{appId}_users.json`，3 天后自动刷新。缓存文件包含 `appId` 前缀，避免多机器人混用。

## Skills 与 Tools：定位与协作

### 什么是 Skill？什么是 Tool？

**Skill（技能）** 和 **Tool（工具）** 是 feishu-pi 中两个核心概念，它们本质不同但协同工作：

#### Skill - 给 AI 的"思考指南"

Skill 是 **Markdown 格式的指导文档**，告诉 AI **如何思考和执行复杂流程**。

```markdown
---
name: code-review
description: 代码审查技能
permission: team
---

# Code Review 流程

1. 检查代码规范（命名、格式、注释）
2. 分析逻辑正确性
3. 评估性能和安全风险
4. 提出改进建议
```

**特点：**
- 📝 纯文本指导，不执行代码
- 🧠 描述"怎么思考"而非"怎么执行"
- 🔄 适合**探索期流程**：步骤还在变化、需要 AI 灵活判断
- 💰 Token 消耗：每次使用都要读取完整内容

**适用场景：**
- 代码审查（需要灵活分析）
- 调试分析（问题千奇百怪）
- 需求讨论（需要多轮对话）

#### Tool - 给 AI 的"执行能力"

Tool 是 **TypeScript 代码**，提供 AI 可以调用的**可执行函数**。

```typescript
export const deployTool: ToolDefinition = {
  name: "deploy_app",
  description: "一键部署应用（测试→构建→推送→部署→健康检查）",
  permission: "admin",
  parameters: {
    type: "object",
    properties: {
      env: { type: "string", enum: ["staging", "prod"] }
    }
  },
  execute: async (toolCallId, params) => {
    await runTests();
    await buildImage();
    await pushToRegistry();
    await updateK8s();
    return await checkHealth();
  }
};
```

**特点：**
- ⚡ 可执行代码，直接产生结果
- 🎯 AI 只需"决策调用"，不需要"思考步骤"
- ✅ 适合**成熟固化流程**：步骤明确、重复频率高
- 💰 Token 消耗：只需读取 description（几十 Token）

**适用场景：**
- 获取数据（天气、时间、数据库查询）
- 执行操作（部署、发送消息、创建工单）
- 固定流程（测试→构建→部署）

### 它们如何协作？

**Skill 和 Tool 是平级关系**，不是从属关系：

```
用户请求
    ↓
   AI
  ╱  ╲
Skill  Tool
```

#### 场景 1：只用 Tool（简单任务）
```
用户: "北京天气怎么样？"
AI: [直接调用 get_weather tool] → "北京 25°C，晴"
```

#### 场景 2：只用 Skill（纯思考任务）
```
用户: "帮我做代码审查"
AI: [读取 code-review skill]
    按指导检查命名→检查逻辑→检查安全→生成报告
```

#### 场景 3：Skill + Tool 协作（复杂任务）
```
用户: "部署应用到生产环境"

AI 读取 deploy-app Skill:
---
部署流程：
1. 用 run_tests 工具确认测试通过
2. 用 git_status 检查没有未提交代码
3. 用 deploy 工具执行部署
4. 用 check_health 确认服务正常
---

AI 执行:
call run_tests() → ✅ 测试通过
call git_status() → ✅ 工作区干净
call deploy(env="prod") → ✅ 部署成功
call check_health() → ✅ 服务健康
```

**类比：**
- **Skill = 装修手册**：告诉你第 3 步该挂画框了
- **Tool = 锤子**：实际完成"敲钉子"的动作
- 手册不需要教你怎么用锤子，AI 会自己选择合适的工具

### 从 Skill 到 Tool 的演进

当一个流程从**探索期**进入**成熟期**，应该考虑把它转成 Tool：

```
模糊探索 → 流程固化 → 工具封装
   Skill  →   Skill   →   Tool
```

**判断标准：**

| 维度 | 保持 Skill | 转成 Tool |
|------|-----------|----------|
| 流程稳定性 | 步骤还在变化 | ✅ 流程已固化 |
| 重复频率 | 偶尔使用 | ✅ 高频重复 |
| 准确性要求 | AI 灵活判断即可 | ✅ 不能出错 |
| Token 消耗 | 可接受 | ✅ 需要优化 |
| 外部依赖 | 无 | ✅ 需要 API/计算 |

**示例：**
- `code-review` → 保持 Skill（需要灵活分析）
- `get-weather` → 必须是 Tool（调用外部 API）
- `deploy-app`（初期）→ Skill（流程探索中）
- `deploy-app`（成熟后）→ Tool（流程固化，提升效率）

### 实际收益对比

**同样的"部署应用"任务：**

| 维度 | 使用 Skill | 使用 Tool |
|------|-----------|----------|
| AI 需要思考 | 5-8 轮（读 Skill + 每步决策） | 1 轮（决定调用） |
| Token 消耗 | ~2000 Token（读完整 Skill + 多轮对话） | ~50 Token（读 description） |
| 可靠性 | ⚠️ 可能跳步骤 | ✅ 代码保证完整 |
| 执行速度 | 慢（多轮 API 调用） | 快（一次调用） |
| 适用阶段 | 探索期 | 成熟期 |

### 目录结构

```
.agent/
├── skills/           # Skill 定义（Markdown）
│   ├── hello.md         - 通用技能
│   ├── code-review.md   - 团队技能
│   └── admin-only.md    - 管理员技能
└── tools/            # 自定义 Tool（TypeScript）
    ├── get-time.ts      - 获取时间工具
    ├── deploy.ts        - 部署工具
    └── query-db.ts      - 数据库查询工具
```

**设计原则：**
- `.agent/` 目录存放**用户定义**的 Skills 和 Tools
- Skills 和 Tools 都支持 `permission` 字段进行权限控制
- Tool 的 `description` 就是它的说明书，无需额外文档
- Skill 可以引导 AI 使用 Tools，但不需要解释 Tool 本身

### 核心理念

1. **独立并列** - Skill 和 Tool 是平级资源，不是从属关系
2. **各司其职** - Skill 负责思考，Tool 负责执行
3. **自然演进** - 流程成熟后从 Skill 转向 Tool
4. **无需重复** - Tool 的 description 足够清晰，不需要 Skill 来做"说明书"

---

## 权限系统

**一个策略文件 + 两道闸门：白名单先行，智能体兜底；常用操作免审，边界操作灵活判断，敏感操作交人工确认。**

- `.agent/permissions.json` 定义各身份组的规则——每条规则用类型前缀标明范围
- 组成员在 `.env` 中通过 `FEISHU_GROUP_<组名>=成员1,成员2,...` 配置，`FEISHU_ADMIN` 自动属于 admin 组
- 每次工具调用时，先过白名单闸门（匹配即放行），未命中交智能体闸门综合判断，再不行弹授权卡交管理员

### 策略文件

```json
{
  "common": [
    "Read(.agent/skills/**)",
    "Tools(query_skill_usage)"
  ],
  "admin": [
    "Read(**)",
    "Write(.agent/**)",
    "Write(data/**)",
    "Tools(*)",
    "Bash(git status:*)",
    "Bash(npm run test:*)",
    "Bash(npm run build:*)"
  ],
  "group1": [
    "Read(docs/**)",
    "Bash(npm run test:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)"
  ]
}
```

`common` 为**默认层**：所有人（含管理员）自动叠加；admin 与各用户组在其上追加自己的规则，生效范围 = `common ∪ 所属组`。

**规则前导词：**

| 前缀 | 模式 | 含义 |
|------|------|------|
| `Read(glob)` | 路径 glob | 该组可读的路径范围 |
| `Write(glob)` | 路径 glob | 该组可写的路径范围 |
| `Tools(name)` | 工具名或 `*` | 该组可调用的自定义工具 |
| `Bash(cmd)` | 命令、`cmd:*` 或 `*` | 该组可执行的 bash 命令（精确/前缀/全部） |

- **admin 组**（保留名）：`FEISHU_ADMIN` 或 `FEISHU_GROUP_ADMIN` 自动属于；未配置的字段取全量缺省（`Bash(*)`、`Read(**)`、`Write(**)`、`Tools(*)`）
- **普通组**（组名任意，如 `group1`、`vip`）：未配置的字段取保守缺省（仅技能目录可读、无工具、无命令）
- **不在任何组**：仅技能目录可读，其余全部拦截
- 一人可属多组，能力取**并集**
- 组文件 mtime 热重载，新会话生效（`/new` 后重算）
- 文件缺失/解析失败时按保守默认处理，不会失效放大权限

### 判定时序（每次工具调用）

```
Read      → 路径在组的 read 范围内？在→放行；不在→拦截（能力边界，不弹卡）
Write     → 路径在组的 write 范围内？在→放行
Tools     → 命中组 tools 名单？在→放行
Bash      → 命令命中组 bash 名单（精确/前缀/*）？在→放行
全部未命中 → 第二道：智能体闸门
              ├─ 符合授权意图 → 放行
              ├─ 超出意图 / 不确定 → 弹授权卡交管理员确认
              └─ 智能体未配置 / 超时 / 异常 → 弹授权卡（fail-safe）
```

读范围是**能力边界**（直接拦截不弹卡）；其余名单外是**风险问题**（先问智能体，再问负责人）。

### /perm 查看策略

管理员发送 `/perm` 可查看每个组的完整规则列表（Read / Write / Tools / Bash 按类型分组展示）。

### 安全保障

1. ✅ **代码层判定** - 工具注册与调用判定全部在代码层，提示词注入绕不过
2. ✅ **最小权限** - 用户默认只能读技能目录、用名单内工具
3. ✅ **防穿越** - 路径判定用 cwd 归一化后的形态，`..` 穿越串不参与匹配
4. ✅ **bash 防拼接** - 含 `;` `&&` `|` 反引号 `$(` 的命令不参与前缀匹配，直接交授权卡
5. ✅ **fail-safe** - 策略文件写坏按最保守处理；策略未命中且智能体未配置 → 直接弹卡

## 工具调用 Guard：白名单 + 授权卡

在组过滤之上，每次工具实际执行前还有一道闸（`beforeToolCall` 钩子，`src/guard/`）。**非允许即 ask**——不存在独立的拒绝列表，不在白名单里的调用一律找管理员确认：

```
工具调用
  ↓
① Read/Write/Bash/Tools 规则命中白名单 → 放行
② 自定义工具（未标高危 risk: "high"）→ 快速放行
③ 其余（白名单未命中 + 高危自定义工具）→ 智能体闸门
     ├─ 符合授权意图 → 放行
     └─ 其他 → 弹授权卡交管理员确认
         ↓
      允许一次 → 执行；拒绝 / 超时 → 拦截
```

**安全设计：**

- **规则语法**：使用 `Read(glob)` / `Write(glob)` / `Tools(name)` / `Bash(cmd)` 前缀格式，大小写不敏感
- **非允许即 ask**：没有拒绝列表——不在白名单里就找管理员确认。想让某个操作免审，就写一条规则；想管住它，就别写
- **自定义工具快速通道**：自定义工具注册时已指定所属组（即已授权），直接放行；逃生口：`risk: "high"` 强制走授权卡
- **授权卡服务端校验**：唯一 `approval_id` + 一次性 `token`；回调校验 token 一致、卡片来源、点击者必须是管理员、decision 合法、未处理过
- **参数脱敏**：授权卡中 `token`、`password`、`api_key`、`secret`、`cookie` 等字段脱敏为 `***`，命令最多展示 1200 字符
- **转发到管理员私聊**：授权卡上有「📨 申请转发给管理员」按钮，管理员可在私聊决策；决策后原卡和转发卡都更新为结果卡

**配置：**

`.agent/permissions.json`（策略规则）：

```json
{
  "admin": ["Read(**)", "Write(.agent/**)", "Tools(*)", "Bash(git push:*)"],
  "group1": ["Read(.agent/skills/**)", "Tools(query_skill_usage)"]
}
```

> 智能体审核（`FEISHU_GUARD_*`）用于白名单未命中时的综合判断：以调用者所属组的策略为参考，判断调用是否符合授权意图——符合则免审放行，否则弹授权卡。未配置时直接弹卡（fail-safe）。

`FEISHU_CMD_WHITELIST` 环境变量已废弃，规则统一在 `.agent/permissions.json`。

## 开发验证

类型检查：

```bash
npm run check
```

当前类型检查和测试均已通过。测试命令为：

```bash
npm test
```

当前结果：12 个测试文件、57 个测试用例通过。回复层使用 CardKit 2.0 流式卡片（CardKit 未启用或 client 未配置时直接报错，不做文本回退）。

## 技能使用统计

机器人会自动记录技能（Skills）的使用情况：当 Agent 通过 `read` 工具读取技能文件（`.agent/skills/` 下的 `.md`）时，在工具执行钩子处写入一条事件。

**为什么不基于 session 统计**：session 文件是 Pi 内部格式（升级易碎）、7 天即被清理、且话题群的 session 由多人共享无法按人归因。因此统计使用**独立的追加式事件流**（`data/stats/skill-usage.jsonl`，一行一条 JSON），只增不删、长期留存，与 session 生命周期解耦。

**两种查看方式：**

1. **飞书内查询**：直接对机器人说「查看技能使用情况」等，Agent 会调用内置的 `query_skill_usage` 工具（所有用户可用），返回使用次数排行、使用者、最近使用时间以及你自己的使用情况。
2. **本地可视化界面**：浏览器打开 `http://localhost:3456/stats`，支持：
   - 按日 / 月 / 年分组的时间分布柱状图
   - 时间范围筛选（近 7/30/90 天、全部、自定义区间）
   - 用户筛选（多选，只看选中的用户）
   - 技能隐藏（多选，排除不关注的技能）
   - 技能排行 / 用户排行表格
   - 调用明细表（月份 × 用户 × 技能：谁在哪个月调了什么、各多少次）——据此评估哪些技能高频值得保留、哪些长期零调用可以考虑下线

**用户展示名**：统计中的人名按 **英文名 > 中文名 > Open ID** 优先级展示（取自用户信息缓存，`src/stats/skill-usage-store.ts` 中解析）。

**说明**：所有用户都可以查询全局统计（内部协作场景）；技能记录的是 Agent 实际读取技能文件的行为，与工具 Guard 的拦截无关（被拦截的调用不会计入）。

## 机器人指令

feishu-pi 提供以下内置指令，在飞书对话中直接输入即可使用：

| `/model` | 查看/切换 AI 模型 | 仅管理员 | 显示当前可用模型列表，点击切换，**即时生效**（新会话使用新模型，同时持久化到 `.env`） |
| `/perm` | 查看权限配置 | 仅管理员 | 显示两档身份说明与工具档位分布 |
| `/help` | 查看帮助信息 | 所有用户 | 显示机器人功能和可用指令 |
| `/new` | 清空当前对话 | 所有用户 | 清空会话历史，开始新对话 |
| `/stop` | 中断当前响应 | 所有用户 | 停止正在生成的 AI 回复 |
| `/detail on` / `/detail off` | 切换详细/精简模式 | 所有用户 | 控制工具调用过程是否保留在正文中，默认精简；无参数时显示当前模式（详见下文） |

**使用示例：**

```
你: /model
机器人: [显示模型列表卡片]

你: /new
机器人: ✅ 已清空当前会话历史。

你: /stop
机器人: ⏸️ 已停止当前响应。

你: /detail on
机器人: ✅ 已开启详细模式：工具调用过程将保留在正文中。…
```

**详细模式与精简模式（`/detail on|off`）：**

回复卡片对工具调用的展示方式分两种，`/detail on` 开启详细模式、`/detail off` 回到精简模式（按会话记忆，默认精简，无参数时显示当前模式）：

- **精简模式（默认，滚动回收）**：过程文字只保留"当前工具 + 正在写的最新一段"——新的正文段出现时，旧工具行与之前的旧正文自动置空收起，避免长任务刷屏；卡片底部小字同步显示工具调用动画
- **终态规则（精简）**：任务结束时只保留**最后一次工具调用之后**的结论段作为答复正文；最后工具后无正文时，退回展示全部正文，不丢已见内容
- **详细模式**：不做回收，全部过程与工具行永久保留在正文中，便于审查完整执行链路
- **模型侧配套**：系统提示已注入"最后一次工具调用之后输出的内容才是最终答复"的规则，要求模型每次工具调用后输出完整独立的结论

**卡片小字：**

每次回复完成后，卡片底部会显示一行统计小字（在正文渲染完成后才出现）：

```
claude-sonnet-4-6 · 90.8K（新增 1.6K） · $1.0886 · 4.6s · 01a05e14
```

- 上下文总 token 及本次新增量
- 本次请求费用（来自模型返回）
- 耗时
- 会话短别名（完整会话 ID 过长，内部维护 别名 → 完整 ID 的映射，见 `src/feishu/session-alias.ts`）

工具调用执行期间，小字位置会显示 `⚙ ⚒ 🛠 工具名 …` 的旋转动画。

**授权卡撤回：**

精简模式下，管理员点击授权卡确认后，授权卡（含转发到管理员私聊的卡片）会被自动撤回，减少会话占用；详细模式下保留授权结果卡，便于审计。

**权限说明：**
- `/model` 仅管理员可用（由 `FEISHU_ADMIN` 配置）
- `/new` 在话题群的话题内被禁止（话题会话为所有人共享，不允许单人清空）
- 其他指令所有用户都可以使用，仅影响自己的会话

**模型切换功能：**
- `/model` 会从配置的模型中继站获取可用模型列表
- 支持无需 API Key 的公开端点
- 智能 URL 候选生成（参考 cc-switch 实现）
- 点击按钮即切换：当前进程内的新会话立即使用新模型，同时持久化到 `.env` 供重启后使用
- 非管理员点击模型按钮会收到「仅管理员可切换模型」提示（服务端校验，与卡片文案无关）
