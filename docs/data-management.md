# 数据管理说明

## 目录结构

统一会话文件夹布局：**一个会话一个文件夹**，历史与附件同住（ID 中的 `:` 等文件系统非法字符替换为 `_`）。

```
data/
├── sessions/
│   ├── conversations.json          # 会话路由表
│   ├── messages.json               # 消息去重表
│   ├── topic-roots.json            # 话题根消息表
│   ├── images/                     # 图片缓存目录（按 imageKey 命名，平铺去重）
│   ├── ou_xxx-chat_oc_xxx/         # 会话专属文件夹（私聊/普通群，按用户隔离）
│   │   ├── 2026-09-12T….jsonl      #   Pi Agent 会话文件（/new 后的新一代同目录累积）
│   │   └── files/                  #   该会话收到的文件附件
│   │       └── 1757…-报表.xlsx
│   └── topic_oc_xxx_om_yyy/        # 话题会话文件夹（话题内共享）
│       ├── ….jsonl
│       └── files/…
├── user-tokens.json                # 用户飞书身份 token（/login，按 openId 一条）
├── stats/
│   └── skill-usage.jsonl           # 技能使用事件流（长期留存，不清理）
└── users/
    └── {appId}_users.json          # 用户资料缓存（3 天过期）
```

## 文件说明

### conversations.json - 会话路由表

**作用：** 映射飞书 conversationId 到对应的 Pi session 文件

**格式：**
```json
{
  "ou_xxx-chat:oc_xxx": {
    "sessionFile": "/path/to/2026-08-30T09-39-04-975Z_xxx.jsonl",
    "updatedAt": "2026-08-30T09:39:05.070Z"
  }
}
```

键的格式由消息所在会话类型决定：

| 场景 | conversationId | 会话归属 |
|------|----------------|---------|
| 私聊 / 普通群 | `{openId}-chat:{chatId}` | 同一群内每个人独立上下文 |
| 群内话题 | `{openId}-{chatId}:thread:{threadId}` | 按用户隔离 |
| 话题群的话题 | `topic:{chatId}:{话题根消息ID}` | 话题内所有人共享 |

**为什么需要：**
- 不同用户/会话需要独立的对话上下文
- 重启后能找到对应的历史会话文件
- 实现会话隔离（A 的历史不会泄露给 B）

**注意：** 本文件不参与过期清理。session 文件被 DataCleaner 删除后，残留的映射在下次使用时由会话层容错处理（打开失败即新建会话）。

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

### topic-roots.json - 话题根消息表

**作用：** 记录 chatId → 话题根消息 ID。话题群的首条消息没有 threadId，用它自己的 messageId 作为话题键；后续消息的 threadId 恰为该根消息 ID，借此收敛到同一会话，避免话题裂成多个会话。

### ../stats/skill-usage.jsonl - 技能使用事件流

**作用：** 记录每次技能文件读取事件（Agent 通过 read 工具读取技能目录下的 .md 时写入），供飞书内查询和本地 `/stats` 统计页面使用

**格式：** JSONL（一行一条事件，只增不删）
```json
{"ts": 1757000000000, "user": "ou_xxx", "skill": "code-review", "chatId": "oc_xxx"}
```

**为什么独立于 session：** session 文件是 Pi 内部格式、7 天清理、话题群多人共享无法按人归因；统计需要长期留存并按「人 × 技能 × 时间」聚合，故使用独立事件流。

**展示名解析：** 事件只存 Open ID；展示时从 `data/users/{appId}_users.json` 按 英文名 > 中文名 > Open ID 解析。

**实现位置：** `src/stats/skill-usage-store.ts`

### xxx.jsonl - Pi Agent 会话文件

**作用：** 存储单个会话的完整对话历史，位于该会话的专属文件夹内

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
- 文件名由 Pi SDK 生成（不可自定义）；会话归属靠所在文件夹与 conversations.json 表达
- `/new` 后的新一代 jsonl 落在同一会话文件夹，旧文件保留至过期清理

### files/ - 会话文件附件目录

**作用：** 存放该会话收到的 file/audio/video 附件

**位置：** `{会话文件夹}/files/`，与该会话的历史 jsonl 同住

**内容：**
- 文件名格式：`{毫秒时间戳}-{消毒后的原始文件名}`（同名文件先后上传不互相覆盖）
- Agent 可通过消息文本中的本地路径直接读取附件
- ✅ 已纳入 DataCleaner 清理（按 mtime 保留 7 天）；清空后 files/ 与空壳会话文件夹自动移除

### user-tokens.json - 用户飞书身份 token

**作用：** 存储 `/login`（Device Flow）授权得到的用户 token，按 openId 一条

**内容：**
- 每条含 `accessToken` / `refreshToken` / 双过期时间 / `scope` / `updatedAt`
- access token 临期由 `getUserAccessToken(openId)` 用 refresh token 静默换新；refresh 也失效则清档并引导重新 `/login`
- 文件在 `data/` 下（已 gitignore）；实际可访问数据 = 应用 scope ∩ 用户本人可见范围

### images/ - 图片缓存目录

**作用：** 缓存用户发送的图片

**内容：**
- 文件名格式：`{imageKey}.{ext}`
- 图片从飞书下载后保存在此（按 imageKey 平铺去重，天然不按会话分）
- 便于调试和事后查看

### ../users/{appId}_users.json - 用户资料缓存

**作用：** 缓存用户中文名、英文名、部门名，避免每条消息都调用飞书 API

**内容：**
- 键为用户 Open ID，条目含 `updatedAt`；成功档案 3 天内命中缓存；全部通道失败写冷却档案（仅 openId + 旧资料），1 天冷却后自动重试
- 文件名带 `appId` 前缀，避免多机器人混用

## 自动清理策略

**清理规则：**
- **保留期限：** 7 天
- **清理对象：**
  - ✅ 会话文件（`{会话文件夹}/*.jsonl`，含根目录平铺的旧布局遗留）- 按文件修改时间
  - ✅ 会话附件（`{会话文件夹}/files/`）- 按文件修改时间；清空后 files/ 与空壳会话文件夹自动移除
  - ✅ 图片缓存 - 按文件修改时间
  - ✅ 消息状态 - 按 updatedAt 时间戳
  - ✅ 卡住的消息（processing 状态超过 1 小时）
- **不清理：**
  - ❌ conversations.json（残留映射由会话层容错兜底）
  - ❌ topic-roots.json
  - ❌ stats/skill-usage.jsonl（统计事件长期留存）
  - ❌ user-tokens.json（不按期清理；refresh 失效时按用户清档）

**触发时机：**
- 启动时执行一次
- 之后每 24 小时自动执行

**实现位置：** `src/runtime/data-cleaner.ts`

## 注意事项

### ✅ 会自动创建的文件

- `conversations.json` - 首次运行时创建
- `messages.json` - 首次运行时创建
- `topic-roots.json` - 首次收到话题群消息时创建
- `{会话文件夹}/xxx.jsonl` - 每个新会话创建一个（/new 后同文件夹再建新文件）
- `{会话文件夹}/files/` - 首次收到文件附件时创建
- `images/` - 首次收到图片时创建
- `user-tokens.json` - 首次 /login 成功时创建
- `data/users/{appId}_users.json` - 首次查询用户资料时创建

### ❌ 不应该手动放入的文件

- 其他格式的文件
- 临时文件
- 日志文件

### ⚠️ 不能合并这些文件

三个 JSON 文件不能合并，因为：
1. `conversations.json` 是 1→N 映射（每个 conversationId 对应一个 session 文件）
2. `messages.json` 是跨所有会话的全局去重
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
