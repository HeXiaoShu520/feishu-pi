# feishu-pi

feishu-pi 是一个基于 [Pi](https://github.com/earendil-works/pi) 的飞书 Agent 应用平台。它深度集成飞书人员身份、会话和权限，为不同的人或群提供不同的 Agent 能力。

架构与选型见 [架构设计](docs/architecture.md)，阶段计划见 [开发路线](ROADMAP.md)。

## 核心特性

- ✅ **CardKit 流式卡片** - 实时显示 Agent 输出（打字机效果 + Markdown 渲染）
- ✅ **图片附件支持** - 发送图片让 Agent 识别和分析（支持视觉模型）
- ✅ **会话隔离** - 按 `chatId` 和 `threadId` 独立会话上下文
- ✅ **消息去重** - 防止重复处理同一消息
- ✅ **自动重连** - WebSocket 断线自动恢复
- ✅ **用户身份** - 自动获取用户 Open ID、英文名和部门信息
- ✅ **内置工具** - 支持 `read`、`write`、`edit`、`bash` 工具

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

```bash
npm install
npx lark-cli config init
npx lark-cli auth login --recommend
npx lark-cli auth status
npm start
```

`@larksuite/cli` 是项目依赖，使用工程本地的 `lark-cli`，不要求全局安装。CLI 缺失、未登录或身份不可用时，服务会在飞书会话中反馈原因。用户的 Open ID、英文名和部门 ID 会在首次聊天时查询并保存到 `memory/users/`；授权凭据由 CLI 自己管理，不写入 `.env`。

启动前至少配置：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
```

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
