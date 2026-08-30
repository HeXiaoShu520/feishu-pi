# feishu-pi

feishu-pi 是一个基于 [Pi](https://github.com/earendil-works/pi) 的飞书 Agent 应用平台。它深度集成飞书人员身份、会话和权限，为不同的人或群提供不同的 Agent 能力。

架构与选型见 [架构设计](docs/architecture.md)，阶段计划见 [开发路线](ROADMAP.md)。

## 核心特性

- ✅ **CardKit 流式卡片** - 实时显示 Agent 输出（打字机效果 + Markdown 渲染）
- ✅ **图片附件支持** - 发送图片让 Agent 识别和分析（支持视觉模型）
- ✅ **会话隔离** - 按 `chatId` 和 `threadId` 独立会话上下文
- ✅ **消息去重** - 防止重复处理同一消息
- ✅ **自动重连** - WebSocket 断线自动恢复
- ✅ **飞书用户上下文** - 自动查询并缓存用户信息（中文名、英文名、部门 ID），供所有技能和 Function Calling 直接使用
- ✅ **三级权限控制** - 管理员/团队/普通用户三级权限，Skills 和工具按角色动态过滤
- ✅ **Skills 支持** - 基于 Pi-agent 的技能系统，支持权限配置
- ✅ **Function Calling** - 自定义工具注册，支持权限控制
- ✅ **受限文件访问** - 非管理员只能读取技能文件，无法访问敏感数据
- ✅ **内置工具** - 管理员可使用 `read`、`write`、`edit`、`bash` 工具
- ✅ **机器人指令** - `/model` 查看/切换模型、`/help` 查看帮助、`/new` 清空对话、`/stop` 中断响应

## 飞书深度定制：用户上下文机制

这是 feishu-pi 区别于通用 Agent 平台的核心基础设施。每条飞书消息到达时，系统会自动：

1. **查询用户信息** - 通过飞书 SDK API 获取用户的中文名、英文名、部门 ID
2. **智能降级** - 如果用户不在应用可见范围（如外部群成员），自动从群成员列表获取
3. **本地缓存** - 缓存 3 天，减少 API 调用，加快响应速度
4. **注入上下文** - 将用户信息注入到每个请求的 `context` 中

**数据结构：**

```typescript
interface FeishuContext {
  userOpenId: string;       // 用户 Open ID
  userName: string;          // 中文名 > 英文名 > Open ID
  departmentIds: string[];   // 部门 ID 列表
  chatId: string;            // 会话 ID
  threadId?: string;         // 话题 ID
  conversationId: string;    // 完整会话标识
}
```

**为什么这很重要：**

- **技能开发零成本** - 所有技能和 Function Calling 直接读取 `context.userName`、`context.departmentIds`，无需自己调用飞书 API
- **权限控制** - 根据部门 ID 或用户身份动态控制技能可用性和工具权限
- **个性化响应** - Agent 可以根据用户部门提供定制化的回答和建议
- **审计追踪** - 每次操作都有明确的用户身份，便于日志记录和问题排查

**存储位置：** `data/users/{appId}_users.json`

**查询策略：**

1. **优先使用机器人 API** - 获取完整信息（中文名、英文名、部门 ID）
2. **降级到群成员列表** - 支持分页查询，适用于外部成员
3. **兜底方案** - 返回最小信息（Open ID），确保服务不中断

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

### 1. 配置飞书应用权限

在 [飞书开放平台](https://open.feishu.cn/) 开发者后台配置以下权限：

**必需权限：**
- `im:message` - 获取与发送单聊、群组消息
- `im:message.group_at_msg` - 接收群聊中 @机器人 消息事件
- `im:message.p2p_msg` - 接收用户单聊消息事件
- `contact:user.base:readonly` - 获取用户基本信息（中文名、英文名、部门 ID）
- `im:chat.member:readonly` - 读取群成员列表（用于外部成员降级查询）

**可选权限（用于图片功能）：**
- `im:resource` - 获取消息中的资源文件（图片附件）

**事件订阅：**
- 订阅方式：选择「使用长连接接收事件/回调」
- 订阊事件：`im.message.receive_v1` - 接收消息

**应用可用范围：**
- 设置可使用该应用的部门或成员范围
- 范围越大，能查询到的用户信息越完整

### 2. 配置 lark-cli（用于外部成员查询）

当用户不在应用可见范围时（如外部群成员），系统会降级使用 `lark-cli` 搜索用户信息：

```bash
npm install -g @larksuite/cli
lark-cli auth login --recommend
lark-cli auth status
```

**lark-cli 需要的用户权限：**
- 以**用户身份**登录（`--as user`）
- 需要搜索用户的权限（通常个人账号默认有）

如果不配置 `lark-cli`，外部成员只能显示名字，无法获取英文名和部门信息。

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
FEISHU_TEAM_MEMBERS=ou_xxx,ou_yyy,张三,李四
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

## 权限系统

feishu-pi 提供三级权限控制，不同角色的用户拥有不同的 Skills 和工具访问权限。

### 权限级别

feishu-pi 根据用户身份分配不同的权限，控制 Skills 和工具的访问范围。

| 角色 | 判断依据 | Skills 权限 | Custom Tools 权限 | 文件操作 | 命令执行 |
|------|---------|------------|------------------|---------|---------|
| **default**（普通用户） | 不在管理员和团队列表中 | `permission: default` 的 skills | `permission: default` 的 tools | ❌ 无 | ❌ 无 |
| **team**（团队成员） | 在 `FEISHU_TEAM_MEMBERS` 列表中 | `permission: default` 或 `team` 的 skills | `permission: default` 或 `team` 的 tools | ❌ 无 | ❌ 无 |
| **admin**（管理员） | 匹配 `FEISHU_ADMIN` 配置 | 所有 skills | 所有 tools | ✅ read/write/edit | ✅ bash |

**权限说明：**
- 每个 skill 和 tool 在定义时可配置 `permission` 字段（`default` / `team` / `admin`）
- 未配置 `permission` 字段的默认为 `default`（所有人可用）
- 系统在创建用户 session 时，根据用户角色自动过滤可用的 skills 和 tools

### 非管理员的受限 read 权限

普通用户和团队成员拥有**受限的 read 工具**，只能读取技能文件：

**✅ 可以读取：**
- `.agent/skills/*.md` - 项目技能
- `.pi/skills/*.md` - Pi 标准技能
- `.agents/skills/*.md` - Agent Skills 标准技能

**❌ 不能读取：**
- `.env` - 环境变量配置
- `src/` - 源代码
- `data/sessions/` - 会话记录
- 其他任意文件

这样设计确保非管理员只能使用技能功能，无法访问敏感信息或修改系统文件。

### Skill 权限配置

在 `.agent/skills/` 下的 skill 文件 frontmatter 中添加 `permission` 字段：

```markdown
---
name: code-review
description: 代码审查技能
permission: team  # default | team | admin
---

# Code Review Skill

审查代码时按以下步骤...
```

**`permission` 字段说明：**

| 值 | 含义 | 可访问的用户 |
|----|------|------------|
| `default` | 通用权限 | 所有用户（普通用户、团队成员、管理员） |
| `team` | 团队权限 | 团队成员和管理员 |
| `admin` | 管理员权限 | 仅管理员 |
| 未配置 | 默认通用 | 等同于 `default`，所有用户可用 |

**示例：**
- 通用技能（如问候、帮助）→ `permission: default` 或不配置
- 业务技能（如代码审查、数据查询）→ `permission: team`
- 敏感操作（如系统配置、用户管理）→ `permission: admin`

### Custom Tool 权限配置

在 `src/tools/` 下的工具定义中添加 `permission` 字段：

```typescript
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const myTool: ToolDefinition = {
  name: "my_tool",
  description: "我的工具",
  permission: "admin",  // default | team | admin
  input_schema: {
    type: "object",
    properties: {
      // ...
    },
  },
  execute: async (toolCallId, params, signal) => {
    // 工具实现
  },
};
```

**`permission` 字段说明：**

| 值 | 含义 | 可访问的用户 |
|----|------|------------|
| `"default"` | 通用权限 | 所有用户（普通用户、团队成员、管理员） |
| `"team"` | 团队权限 | 团队成员和管理员 |
| `"admin"` | 管理员权限 | 仅管理员 |
| 未配置 | 默认通用 | 等同于 `"default"`，所有用户可用 |

**示例：**
- 查询类工具（如获取时间、查询天气）→ `permission: "default"`
- 业务操作（如创建工单、查询数据库）→ `permission: "team"`
- 系统操作（如修改配置、重启服务）→ `permission: "admin"`

### 团队成员配置

在 `.env` 文件中配置团队成员列表：

```env
FEISHU_TEAM_MEMBERS=ou_xxx,ou_yyy,张三,李四,admin@example.com
```

**支持的格式：**
- Open ID：`ou_xxxxxxxx`
- 中文姓名：`张三`
- 英文姓名：`John`
- 邮箱：`admin@example.com`

启动时会自动解析所有团队成员的 Open ID。

### 安全保障

1. ✅ **代码层权限控制** - 在创建 session 时根据用户角色动态过滤工具列表
2. ✅ **防提示词注入** - 权限判断在代码层执行，AI 无法通过提示词绕过
3. ✅ **最小权限原则** - 非管理员默认无文件和命令操作权限
4. ✅ **路径隔离** - 受限 read 工具只允许访问技能目录
5. ✅ **审计追踪** - 启动日志显示每个用户的角色和可用工具

### 权限判断逻辑

```typescript
function getUserRole(userId: string): "default" | "team" | "admin" {
  if (userId === adminId) return "admin";
  if (teamMemberIds.includes(userId)) return "team";
  return "default";
}
```

每个用户的 session 创建时，系统会：
1. 根据 `userId` 判断角色
2. 过滤可用的 skills 和 custom tools
3. 选择对应的内置工具（管理员全部，其他受限 read）
4. 在日志中显示加载的资源



## 开发验证

类型检查：

```bash
npm run check
```

当前类型检查和测试均已通过。测试命令为：

```bash
npm test
```

当前结果：4 个测试文件、7 个测试用例通过。回复层已接入 CardKit 2.0 流式卡片，异常时保留文本回复回退。

## 机器人指令

feishu-pi 提供以下内置指令，在飞书对话中直接输入即可使用：

| 指令 | 功能 | 权限要求 | 说明 |
|------|------|---------|------|
| `/model` | 查看/切换 AI 模型 | 仅管理员 | 显示当前可用模型列表，点击切换（开发中） |
| `/help` | 查看帮助信息 | 所有用户 | 显示机器人功能和可用指令 |
| `/new` | 清空当前对话 | 所有用户 | 清空会话历史，开始新对话 |
| `/stop` | 中断当前响应 | 所有用户 | 停止正在生成的 AI 回复 |

**使用示例：**

```
你: /model
机器人: [显示模型列表卡片]

你: /new
机器人: ✅ 已清空当前会话历史。

你: /stop
机器人: ⏸️ 已停止当前响应。
```

**权限说明：**
- `/model` 仅管理员可用（由 `FEISHU_ADMIN` 配置）
- 其他指令所有用户都可以使用，仅影响自己的会话

**模型切换功能：**
- `/model` 会从配置的模型中继站获取可用模型列表
- 支持无需 API Key 的公开端点
- 智能 URL 候选生成（参考 cc-switch 实现）
- 当前版本仅支持查看，切换功能开发中
