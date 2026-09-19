# 数据管理说明

## 一句话模型

**一次会话 = 磁盘上一个目录**（会话目录）。会话期间产生的所有文件——Pi 历史（jsonl）、用户发来的图片、文件附件——全部落在该目录里；会话目录之外的 `data/` 只放"特殊"长期数据（记忆、用户、凭证、索引、共享缓存）。

清理也以**会话目录**为单位：整个目录超过保留期（7 天）就整体删除，不做文件级删减。

```
work_space/                              # 会话目录根（一次会话一个目录）
└── 20260919-145252-a1b2c3/              # 会话目录，名字就是会话 id
    ├── session.json                     # 目录自述：会话 id / 所属会话 / 创建时间
    ├── 2026-09-19T11-11-58-272Z_….jsonl # Pi 会话历史
    ├── images/                          # 该会话收到的图片（按 imageKey 命名）
    │   └── img_v3_….jpg
    ├── files/                           # 该会话收到的文件附件
    │   └── 1757…-报表.xlsx

data/                                    # 非会话数据（长期）
├── sessions.json                        # 会话索引：conversationId → 当前会话
├── messages.json                        # 消息去重表
├── topic-roots.json                     # 话题根消息表
├── memory/MEMORY.md                     # 团队记忆
├── credentials/                         # 加密凭证库（lark.vault.json / .vault-key / meegle.vault.json）
├── users/{appId}_users.json             # 用户资料缓存（3 天过期）
├── schedules.json                       # 定时任务表
└── stats/skill-usage.jsonl              # 技能使用事件流（长期留存）
```

## 会话身份与目录分配

| 概念 | 含义 |
|------|------|
| `conversationId` | 飞书会话归属：私聊 / 群聊 / 话题（见下表），长期稳定 |
| `sessionId` | 一"代"会话，形如 `20260919-145252-a1b2c3`，同时就是会话目录名 |
| 会话记录 | `{ sessionId, dir, sessionFile?, createdAt, updatedAt }`，存在 `data/sessions.json` |

**一个 conversationId 任一时刻只对应一个会话**；`/new` 换一代（新会话 id + 新会话目录 + 空历史），**旧目录留在磁盘上**，由保留期清理统一收走——所以历史不会当场消失，翻得到但不再参与对话。

分配与落点由 `SessionStore`（`src/runtime/session-store.ts`）统一负责，它是"会话目录在哪"的唯一事实来源：

- 传输层下载图片/附件时向它要目录（`dirFor`），运行时落 Pi 会话文件时也向它要目录 → 二者必然在同一个会话目录里；
- 会话目录被清理掉后再来消息，`getOrCreate` 发现目录不在了就重建一代会话（不会把一个不存在的目录当成有效会话）；
- 记录 Pi 落盘文件时带**代次校验**：`/new` 之后仍在跑的上一条消息不会把旧会话文件写回新记录。

`conversationId` 的取值规则（由消息所在飞书会话类型决定）：

| 场景 | conversationId | 会话归属 |
|------|----------------|---------|
| 私聊 / 普通群 | `{chatMode}-{chatId}` | 私聊 = 本人历史；普通群 = 全群共享 |
| 话题群的话题 | `topic:{chatId}:{话题根消息ID}` | 话题内所有人共享 |
| 定时任务 | `{创建人}-schedule:{任务ID}` | 按任务隔离 |

## 文件说明

### `session.json` - 会话目录自述

```json
{ "sessionId": "20260919-145252-a1b2c3", "conversationId": "p2p-oc_2f6b…", "createdAt": "2026-09-19T14:52:52.000Z" }
```

人工排查时一眼看出"这是哪个会话的目录"，随目录一起被清理，不参与任何逻辑判断。

### `*.jsonl` - Pi 会话历史

- 文件名 `{ISO8601时间}_{随机ID}.jsonl`，由 Pi SDK 生成（不可自定义），会话归属靠所在目录表达；
- `/new` 之后新一代 jsonl 落在**新的会话目录**，旧目录保留至过期清理；
- 会话索引（`data/sessions.json`）只记录**最新一代**的文件；同目录内的旧代 jsonl 属历史留档。

### `images/` - 会话收到的图片

按 `{imageKey}.jpg` 命名。图片本体不写入会话记录（易失内容不落盘），消息文本里带上本地路径，需要时模型可用 read 工具取回原图。

### `files/` - 会话收到的文件附件

文件名 `{毫秒时间戳}-{消毒后的原始文件名}`（同名文件先后上传不互相覆盖），单条消息最多下载 5 个，Agent 可通过消息文本里的路径直接读取。

### `data/sessions.json` - 会话索引

```json
{
  "p2p-oc_2f6b…": {
    "sessionId": "20260919-145252-a1b2c3",
    "dir": "E:/…/work_space/20260919-145252-a1b2c3",
    "sessionFile": "E:/…/work_space/20260919-145252-a1b2c3/2026-09-19T11-11-58-272Z_….jsonl",
    "createdAt": 1789000000000,
    "updatedAt": 1789000000000
  }
}
```

**作用：** conversationId → 当前会话（目录与 Pi 会话文件），重启后据此恢复到同一会话。
**清理：** 索引本身不按期清理；指向的目录被清理后，下次使用时按"目录不存在 → 重建会话"处理（残留条目被就地覆盖）。
**为什么不合并进别的表：** 它天然是 1→1 的当前态映射，与消息去重表（全局、只增）、话题根表（群 → 待定根）语义不同。

### `data/messages.json` - 消息去重表

```json
{ "om_messageId1": { "status": "completed", "updatedAt": 1788084142478 } }
```

飞书 WebSocket 重连可能重发历史消息，用 `claim()` 保证同一条消息只处理一次。状态 `processing → completed/failed`；`processing` 卡住超过 1 小时视为异常并清理。

### `data/topic-roots.json` - 话题根消息表

记录 `chatId → 待定话题根 messageId`。话题群首条消息没有 threadId，用它自己的 messageId 当话题键，后续消息的 threadId 恰为该根消息 ID，借此收敛到同一会话，避免话题裂成多个会话。

### `data/users/{appId}_users.json` - 用户资料缓存

键为用户 openId，条目含 `updatedAt`；成功档案 3 天内命中缓存；所有通道都失败时写冷却档案（仅 openId + 旧资料），1 天冷却后自动重试。文件名带 `appId` 前缀，多机器人不混用。

### `data/stats/skill-usage.jsonl` - 技能使用事件流

记录 `read` 工具读取技能文件的每次事件，JSONL 只增不删。之所以独立于会话：session jsonl 是 Pi 内部格式、7 天清理、话题群多人共享无法按人归因；统计需要长期留存并按「人 × 技能 × 时间」聚合。展示名从 `data/users/{appId}_users.json` 按「英文名 > 中文名 > Open ID」解析。

## 自动清理策略

**规则：以会话目录为单位，整个目录过期即整体删除。**

| 对象 | 判定 | 处理 |
|------|------|------|
| 会话目录 `work_space/{sessionId}/` | 目录树内最新 mtime（= 该会话最后一次活动）早于 7 天前 | `rm -rf` 整目录 |
| 会话根下散落的文件（旧布局遗留） | 文件 mtime 早于 7 天前 | 删除文件 |
| 消息去重表条目 | `updatedAt` 早于 7 天前 | 删条目 |
| 卡住的消息 | `processing` 状态超过 1 小时 | 删条目 |

**为什么不按文件清理：** 会话目录是不可分割的整体，按文件删只会留下"历史没了、附件还在"的半截会话——既无法使用，也无法解释。目录树内最新 mtime 作为"最后活跃时间"，保证还在使用的会话不会被误删（老文件待在新会话目录里也不会被单独清掉）。

**不清理：** `data/` 下的记忆、用户资料、凭证、会话索引、话题根表、技能统计、定时任务表——它们要么是长期资产，要么有各自的过期策略。

**触发时机：** 启动时执行一次，之后每 24 小时一次。
**实现位置：** `src/runtime/data-cleaner.ts`。

## 注意事项

### ✅ 会自动创建

- `work_space/{sessionId}/`（含 `session.json`）— 会话第一句话时创建
- `{会话目录}/images|files/` — 首次收到图片/附件时创建
- `data/sessions.json` / `data/messages.json` — 首次运行时创建
- `data/topic-roots.json` — 首次收到话题群消息时创建
- `data/users/{appId}_users.json` — 首次查询用户资料时创建

### ❌ 不要手工往会话目录外扔东西

会话产物一律进会话目录；`work_space/` 下除会话目录外不应出现其他文件（出现了会被当作过期遗留清掉）。需要长期保留的东西放 `data/` 下，并且要有明确的归属与过期策略。
