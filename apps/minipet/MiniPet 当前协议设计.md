# MiniPet 本地协议 v1

## 目标

MiniPet 和 mini-claw 是同一工程的前端与内核，使用父子进程 stdin/stdout 通信：

- 不监听端口；
- 不需要 WebSocket、HTTP fallback 或服务发现；
- 一行一个 JSON，天然支持流式输出；
- 所有模型、会话、工具和权限逻辑只在 mini-claw 内核中存在。

## 启动关系

```text
MiniPet
  └─ npm run start -- --stdio
       ├─ stdin  ← MiniPet 请求
       └─ stdout → MiniPet surface 事件
```

日志必须写 stderr，不能写入 stdout。开发模式把子进程命令换成 `npm run dev -- --stdio`。

历史唯一来源是 mini-claw 的 Pi session JSONL（`work_space/<session>/`）。MiniPet 不创建或写入第二份聊天历史，只请求历史投影并负责渲染。

## JSON 信封

```json
{
  "version": "1.0",
  "type": "user.input",
  "payload": {},
  "request_id": "optional"
}
```

必要字段只有 `version`、`type`、`payload`；`request_id` 只在需要关联请求时使用。`version` 必须是 `1.0`，`type` 必须属于下表；未知版本或类型应返回 `error`，不得静默当作普通文本。

## 消息类型

### 握手

MiniPet：

```json
{"version":"1.0","type":"session.hello","payload":{"protocol":"minipet.v1","client":{"name":"MiniPet"}}}
```

mini-claw：

```json
{"version":"1.0","type":"session.ready","payload":{"protocol":"minipet.v1","server":{"name":"mini-claw"}}}
```

### 输入

```json
{
  "version": "1.0",
  "type": "user.input",
  "payload": {
    "text": "你好",
    "mode": "text",
    "surface": "chat_window",
    "session_id": "chat-1",
    "turn_id": "turn-1",
    "surface_id": "surface-1",
    "attachments": []
  }
}
```

`attachments` 的图片使用 `encoding: "base64"`，由 mini-claw 统一做大小限制和 Pi 图片输入转换。

### 流式 surface

```json
{
  "version": "1.0",
  "type": "surface.update",
  "payload": {
    "session_id": "chat-1",
    "turn_id": "turn-1",
    "surface_id": "surface-1",
    "status": "streaming",
    "content": "正在生成的正文",
    "progress": "正在调用工具：bash",
    "content_kind": "final",
    "tts_eligible": true
  }
}
```

终态使用 `status: "done"` 或 `status: "failed"`。`surface.show` 和 `surface.update` 共用相同 payload，客户端只按 `type` 决定创建还是更新。

### 历史

MiniPet 请求当前会话历史：

```json
{"version":"1.0","type":"history.get","request_id":"history-1","payload":{"session_id":"minipet:global"}}
```

mini-claw 返回当前 Pi 分支的展示投影，不暴露工具调用、思考块或模型字段：

```json
{
  "version":"1.0",
  "type":"history.result",
  "request_id":"history-1",
  "payload":{"session_id":"minipet:global","messages":[
    {"role":"user","content":"你好","timestamp":"2026-09-23T00:00:00.000Z"},
    {"role":"assistant","content":"你好！"}
  ]}
}
```

聊天窗是只读历史查看器，不提供清空、发送或授权操作；会话换代由飞书命令和内核会话管理负责。

### 中断与授权

`user.cancel` 只需携带 `session_id`、`turn_id`、`surface_id` 中能定位本轮的字段。`user.approval` 必须携带服务端下发的 `message_id`、`approval_id`、`token` 和 `decision`，服务端拒绝任何未登记或重复回调。
