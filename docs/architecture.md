# 架构与运行机制

## 范围

单进程、单飞书应用的智能体后端，同时可选接入本机 MiniPet 桌面前端。复用 Pi 的模型适配、Agent loop、SessionManager 和编码工具，不自建 Agent 框架。

```text
飞书 WebSocket / EventDispatcher                 MiniPet stdin/stdout JSONL
  → LarkTransport                                 → MiniPetServer：协议归一化、图片解码、surface 流式输出
  → FeishuAgentBridge：消息认领、命令、回复生命周期       ↘
                         → ConversationManager：同会话串行、打断、恢复与换代
  → FeishuPiRuntime：Pi AgentSession、资源与工具
  → beforeToolCall：权限策略 → ToolGuard → 审核模型 / 授权卡
  → Pi 事件 → ReplyParts → CardKitReply → CardKitStream
```

`main.ts` 装配服务。机器人身份获取失败会终止启动；管理员解析失败则继续运行，但管理员授权能力不可用。技能、工具和权限在接收消息前预加载。

MiniPet 由桌面端拉起 mini-claw 子进程，使用 `minipet.v1` 本地 JSONL 协议通信，不监听端口。`session_id` 映射为 `minipet:{user}:{session}`，保证桌面聊天窗口跨轮复用同一 Pi 历史；历史展示通过 `history.get/result` 读取 Pi session，桌面端不再维护第二份消息库；`turn_id/surface_id` 只负责一轮回复卡片的更新。详见 [MiniPet 前端接入](minipet-integration.md)。

## 会话与身份

| 场景 | conversationId | 历史范围 |
|---|---|---|
| 私聊 | `p2p-{chatId}` | 本人与机器人 |
| 普通群 | `group-{chatId}` | 全群共享 |
| 话题群 | `topic:{chatId}:{threadId 或根消息 messageId}` | 同一话题共享 |
| 定时任务 | `{创建人}-schedule:{任务ID}` | 该任务独立历史 |

根消息直接用自身 messageId；回复用 threadId，不用群级“待定话题根”猜测归属。不同新话题因此不会合并。

`FeishuContext` 携带 `userOpenId`、`userName`、`en_name`、`department_name`、`chatId`、`threadId`、`chatMode`、`conversationId`、`isAdmin`。它用于权限和工具身份，不会自动作为完整对象注入模型。入站预处理把当前发言人写成 `姓名(open_id): 内容`；真实 @、本地已知姓名和引用链中的人物在内容里标注 open_id。引用原文按层标记发言人，图片和附件也随引用传入。卡片 2.0 按消息 ID 读取可见原文；合并转发逐条标识发言人。模型收到机器人显示名和本轮已确认人物，直接生成 CardKit Markdown 与原生 `<at id=ou_xxx></at>` 提及；发送层原样发送正文，不再把 `姓名(open_id)` 改写为提及标签。

机器人经受控 `lark-cli` 读取飞书聊天历史时，历史输出里的 Card 2.0 也按消息 ID 补取可见原文，使用该命令本来的用户或机器人身份。给模型的历史条目增加 `speaker: 姓名(open_id)`；飞书回复卡片只显示可点击的人名，不在卡片上额外显示 open_id。
接收与历史卡片按正文中每个 `<at>` 标签自己的 open_id 就地展开，重复提及保留，机器人自身的 open_id 排除；姓名映射不依赖附件人物表的排列顺序。模型生成的卡片正文原样发送，因此多人提及的语义配对仍取决于模型输出，发送层不重排标签。

语音优先读取飞书消息自带的 `speech_to_text`。没有转写时，可通过 `FEISHU_PI_STT_MODEL` 配置 OpenAI 兼容转写服务；没有配置则保留语音附件及其路径，并明确标记未转写。

每个会话使用 Promise 队列。新消息中断当前生成并排队；不同会话并行。共享会话换发言人时，在队列内从同一历史文件重建 Pi 会话，重新绑定凭证、记忆、定时任务创建者及授权对象。共享的是历史，不是前一人的工具身份。

Pi 事件的异步处理按顺序排空后才结算回复。初始化失败不缓存失败 Promise，后续消息可重试。`/new` 更换会话目录，代次校验阻止旧请求覆盖新索引。`/stop` 中断当前生成；话题内禁止 `/new`。

## 权限

`.agent/permissions.json` 是 deny 风险规则和两层白名单的来源。规则格式统一为 `Bash(命令glob)`、`Read(路径glob)`、`Write(路径glob)`、`Tools(工具名glob)`：

```json
{
  "deny": ["Read(**/.env*)", "Write(data/credentials/**)", "Bash(**.env*)"],
  "allow": {
    "admin": ["Read(**)", "Write(.agent/**)", "Tools(*)"],
    "group": ["Read(docs/**)", "Tools(memory)", "Bash(git status:*)"]
  }
}
```

身份只有两层：`admin` 由 `FEISHU_PI_ADMIN` 解析出的 open_id 识别；其余所有用户自动属于 `group`。管理员未配置或解析失败时，所有用户均属于 `group`。管理员也只获得显式配置的权限；配置缺失、损坏或字段未配置不会补全权限。`deny` 完全来自配置，没有隐藏的内置禁止清单。

内置 `read/write/edit/bash` 和自定义工具注册到会话，执行时统一检查权限，而不是按组隐藏技能说明。`ask_user_question` 是所有人可用的交互工具。

调用判定顺序：

1. `deny` 按工具类型和参数通配命中时，阻止白名单直通；命中规则会和调用上下文一起交给审核模型，作为风险信号，不预设审批人。
2. 未命中 `deny` 时，Bash、读写路径或自定义工具命中调用者白名单直接放行。命令前缀要求参数边界，复杂 shell 构造不直接按前缀放行。
3. 一切其余调用（包括 `read` 和自定义工具）都交给审核模型。模型收到完整策略、调用者角色、是否管理员、有效白名单和高风险标记，输出 `allow`、`admin` 或 `user`。
4. `allow` 直接执行；`admin` 发管理员单次授权卡；`user` 仅由当前请求者本人确认。未配置审核模型、超时、异常或无法解析一律回退管理员卡；拒绝、超时、中断或无法发卡均不执行。

这是应用级审核，**不是操作系统沙箱**。Bash 授权涵盖该命令的全部行为，`Read` 规则不限制已获准执行的 shell 子进程；符号链接、脚本及 CLI 扩展也不能靠命令文本过滤彻底隔离。只为受信任用户配置广泛的 Bash/Write 权限。审核模型也不是确定性的安全边界。

## 用户资料与登录

普通消息发送者资料只读取已有缓存与本人登录时返回的资料，缺少姓名时显示 `open_id`。消息里真实 @ 其他人时，由消息预处理程序自动用管理员用户 token 查询被 @ 者资料并缓存；此通道不暴露给 AI，也不用于发卡或业务命令。启动时不扫描团队名单，也不遍历或预热所有用户凭证。

`UserAuthService` 管理飞书 Device Flow 和按需刷新；`StaticCredentialService` 管理 Meegle 凭证。`identity-bash.ts` 在 Bash 内提供 CLI 入口，`cli-proxy.ts` 在每条 CLI 真正启动时按当前发起人绑定身份；普通 shell 命令不接收用户凭证。用户态 CLI 缺凭证时拒绝执行并引导授权。显式 `--as bot` 使用当前机器人应用的 App ID/Secret；管理员用户凭证仅供固定的被 @ 人资料入库流程。每次 Bash 调用采用独立的临时 CLI 配置目录，避免使用宿主机 CLI 账号缓存。

## 模型与资源

供应商由模型名推断：包含 claude → anthropic，包含 deepseek → deepseek，其余 → openai。目录命中则使用 Pi 模型定义；未命中时可能继承同供应商模型定义，最终使用兼容协议兜底。目录外模型的能力和计价需按实际服务核实。

`/model` 持久化模型名并更新运行时供应商；已驻留会话继续使用原模型，重建后生效。`SYSTEM.md`、技能和自定义工具进程内加载一次。项目上下文只接受工程目录内的 AGENTS.md / CLAUDE.md。

## 定时任务和记忆

`schedule_manager` 已接通对话：创建、列出、删除、启停、立即执行。工具只允许操作调用者自己的任务。调度支持 5 段 cron、一次性 `at` 和固定间隔 `every`；cron 可指定 IANA 时区，未指定时使用服务进程本地时区。同一任务执行中再次触发会跳过，避免周期性中断上一轮。

任务以创建者身份、独立会话执行，结果发往创建时的 chatId。prompt 必须包含执行所需的对象、范围与输出要求；后续触发可看到该任务自己的历史。没有任意的最短字数限制。

`memory` 按 openId 读写 `data/memory/{openId}.md`，支持读取、追加和整理覆盖。群内工具返回的内容会进入共享历史，敏感个人信息应在私聊处理。

## 持久化与回复

索引和消息状态通过 JsonMapStore 串行原子写入；清理使用同一个 MessageStore，避免与消息处理抢写。凭证独立加密存储。具体路径和保留期见 [数据管理](data-management.md)。

回复只用 CardKit，不自动降级为普通文本。默认精简模式只保留最后工具段后的结论，详细模式保留过程。中断时撤回复卡；完整历史是否已写入取决于 Pi 事件进度。回复小字统计来自 Pi Session，非独立技能使用统计。
