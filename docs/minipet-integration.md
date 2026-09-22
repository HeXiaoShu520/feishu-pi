# MiniPet 接入说明

MiniPet 是 mini-claw 的本地桌面前端。它不再连接端口，也不保存模型或权限配置；启动后由 MiniPet 拉起一个 mini-claw 子进程，双方使用 stdin/stdout 的 JSONL 信封通信。

```text
MiniPet(PySide6)
   │ stdin/stdout：一行一个 JSON
   ▼
mini-claw(Node/Pi)
   └─ ConversationManager → AgentSession / 工具 / 权限 / 飞书
```

历史只有一个来源：mini-claw 的 Pi session JSONL（`work_space/<session>/`）。MiniPet 不再写 `data/chat`，只通过协议拿到展示投影；清空历史也由内核执行会话换代。

## 启动

根目录 `.env` 配置桌面端对应的真实飞书用户：

```dotenv
MINIPET_USER_OPEN_ID=ou_xxxxxxxxxxxxxxxxxxxxxxxx
```

这是 MiniPet 子进程的服务端绑定身份；`--stdio` 启动时会校验它必须是 `ou_...`，不会接受 `minipet_user` 之类的占位值。

然后执行：

```powershell
npm run minipet   # 稳定模式：MiniPet 自动拉起 npm start -- --stdio
npm run dev:all   # 开发模式：MiniPet 自动拉起 npm run dev -- --stdio
```

不需要旧的桌面端开关、host、port、WebSocket 地址或 HTTP fallback。`npm run dev` 仍然可以单独启动飞书服务，但如果要同时使用桌面端，推荐使用上面的 `npm run dev:all`，避免启动两个内核实例。

## 协议边界

协议版本为 `minipet.v1`，每行是一个 JSON 对象：

| 方向 | 类型 | 用途 |
|---|---|---|
| MiniPet → mini-claw | `session.hello` | 启动握手 |
| mini-claw → MiniPet | `session.ready` | 内核已就绪 |
| MiniPet → mini-claw | `user.input` | 文本、语音结果、图片和拖放输入 |
| MiniPet → mini-claw | `user.cancel` | 中断当前轮次 |
| MiniPet → mini-claw | `user.approval` | 本地授权卡按钮回调 |
| MiniPet → mini-claw | `history.get` | 请求当前会话历史投影 |
| MiniPet → mini-claw | `history.clear` | 请求内核换代并清空当前会话 |
| mini-claw → MiniPet | `history.result` | 返回当前分支的用户/助手消息 |
| mini-claw → MiniPet | `history.cleared` | 确认历史已清空 |
| mini-claw → MiniPet | `surface.show` | 创建回复卡片/流式卡片 |
| mini-claw → MiniPet | `surface.update` | 增量正文、工具进度、终态 |
| mini-claw → MiniPet | `surface.close` | 关闭卡片 |

一轮输入使用三个关联字段：

- `session_id`：桌面聊天会话，对应 mini-claw 的稳定 `conversationId`。
- `turn_id`：一次用户输入。
- `surface_id`：这一轮在桌面上的卡片/流式视图。

所有信封必须是 `version: "1.0"`，`type` 必须在握手能力列表中；未知版本或消息类型直接拒绝。`history.result` 只返回 `role`、`content`、`timestamp`，不把 Pi 内部 entry、工具调用和模型字段暴露给桌面端。

内核先发送 `surface.show`，后续通过 `surface.update` 更新正文和 `progress`。正文增量直接复用 Pi 的流式事件，工具进度单独放在 `progress`，不会混入正文或触发 TTS。

## 授权安全

桌面端只展示服务端下发的授权卡，不自行决定权限。卡片按钮回传 `approval_id`、一次性 `token`、`decision` 和服务端生成的 `message_id`；mini-claw 还会校验卡片与当前会话/进程的绑定，并使用 `.env` 中的 `MINIPET_USER_OPEN_ID` 注入操作者身份。

因此本地按钮不是安全边界，真正的权限判断仍在 `PermissionBroker`、`ToolGuard` 和 `.agent/permissions.json`。
