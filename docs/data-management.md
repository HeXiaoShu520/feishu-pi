# 数据管理说明

## 目录结构

```
data/sessions/
├── conversations.json          # 会话路由表
├── messages.json               # 消息去重表
├── images/                     # 图片缓存目录
│   └── img_xxx.jpg            # 按 imageKey 命名
└── 2026-08-30T...xxx.jsonl    # Pi Agent 会话文件
```

## 文件说明

### conversations.json - 会话路由表

**作用：** 映射飞书会话 ID 到对应的 Pi session 文件

**格式：**
```json
{
  "chat:oc_xxx": {
    "sessionFile": "/path/to/2026-08-30T09-39-04-975Z_xxx.jsonl",
    "updatedAt": "2026-08-30T09:39:05.070Z"
  }
}
```

**为什么需要：**
- 不同群聊需要独立的对话上下文
- 重启后能找到对应的历史会话文件
- 实现会话隔离（群 A 的历史不会泄露给群 B）

### messages.json - 消息去重表

**作用：** 跨所有群聊的全局消息去重

**格式：**
```json
{
  "om_messageId1": {
    "status": "completed",
    "updatedAt": 1788084142478
  },
  "om_messageId2": {
    "status": "processing",
    "updatedAt": 1788082075682
  }
}
```

**状态流转：**
- `processing` - 正在处理
- `completed` - 处理完成
- `failed` - 处理失败

**为什么需要：**
- 飞书 WebSocket 重连时可能重发历史消息
- 防止重复处理导致用户看到多次回复
- 追踪消息处理状态

### xxx.jsonl - Pi Agent 会话文件

**作用：** 存储单个群聊的完整对话历史

**格式：** JSONL（每行一个 JSON 对象）
```jsonl
{"type":"user","content":"你好"}
{"type":"assistant","content":"你好！有什么可以帮你的？"}
{"type":"tool_call","name":"read","args":{}}
```

**为什么需要：**
- Pi Agent SDK 需要历史消息来维持对话连贯性
- 重启后能继续上次的话题
- 记录完整的工具调用历史

**命名规则：**
- 格式：`{ISO8601时间}_{随机ID}.jsonl`
- 示例：`2026-08-30T09-39-04-975Z_abc123.jsonl`

### images/ - 图片缓存目录

**作用：** 缓存用户发送的图片

**内容：**
- 文件名格式：`{imageKey}.{ext}`
- 图片从飞书下载后保存在此
- 便于调试和事后查看

## 自动清理策略

**清理规则：**
- **保留期限：** 7 天
- **清理对象：**
  - ✅ 会话文件 (.jsonl) - 按文件修改时间
  - ✅ 图片缓存 - 按文件修改时间
  - ✅ 消息状态 - 按 updatedAt 时间戳
  - ✅ 卡住的消息（processing 状态超过 1 小时）

**触发时机：**
- 启动时执行一次
- 之后每 24 小时自动执行

**实现位置：** `src/runtime/data-cleaner.ts`

## 注意事项

### ✅ 会自动创建的文件

- `conversations.json` - 首次运行时创建
- `messages.json` - 首次运行时创建
- `xxx.jsonl` - 每个新会话创建一个
- `images/` - 首次收到图片时创建

### ❌ 不应该手动放入的文件

- 其他格式的文件
- 临时文件
- 日志文件

### ⚠️ 不能合并这些文件

三个 JSON 文件不能合并，因为：
1. `conversations.json` 是 1→N 映射（一个群对应一个 session）
2. `messages.json` 是跨所有群聊的全局去重
3. `xxx.jsonl` 是 Pi SDK 管理的标准格式，不能修改

## 磁盘占用预估

**典型场景（单个群聊）：**
- conversations.json: ~200 bytes（固定开销）
- messages.json: ~100 bytes × 消息数
- 单个 session.jsonl: ~1-10 KB（取决于对话轮数）
- 单张图片缓存: 50-500 KB

**7 天保留期预估：**
- 10 个活跃群聊 × 每天 50 条消息 = 3500 条消息
- messages.json: ~350 KB
- session 文件: 10 × 50 KB = 500 KB
- 图片缓存（假设每天 10 张）: 70 × 200 KB = 14 MB
- **总计：** ~15 MB

## SDK 依赖

**Pi Agent SDK：**
- session.jsonl 文件由 SDK 自动管理
- 我们只负责提供文件路径和清理策略
- 具体格式规范参考 Pi Agent SDK 文档
