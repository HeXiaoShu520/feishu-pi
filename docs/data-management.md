# 数据管理

## 布局

```text
work_space/{sessionId}/
  session.json                 # 会话目录自述
  *.jsonl                      # Pi 历史
  images/                      # 图片
  files/                       # 文件、语音、视频附件

data/
  sessions.json                # conversationId → 当前会话目录与历史文件
  messages.json                # 消息认领和处理状态
  schedules.json               # 定时任务
  memory/{openId}.md           # 个人长期记忆
  users/{appId}_users.json      # 用户资料缓存
  credentials/lark.vault.json  # 飞书用户凭证，AES-256-GCM
  credentials/meegle.vault.json
  .vault-key                   # 凭证库主密钥
```

`data/` 和 `work_space/` 不入版本库。当前没有技能使用事件库；旧 `topic-roots.json` 已不再读取。

## 会话生命周期

`SessionStore` 分配 `{日期}-{时间}-{尾段}` 目录（尾段为发起人 openId 后 6 位加短随机串，`mkdir` 非递归保证不覆盖），传输层和 Pi 共用目录。`conversationId` 对应飞书会话或话题，`sessionId` 对应一代历史。路由规则见 [架构](architecture.md)。

创建 Pi 会话后尽早持久化索引。`/new` 新建一代，旧目录留存；迟到的旧会话写入受代次校验限制。目录被清理后，下次访问自动重建。

历史写入时移除 thinking 块和顶层 reasoning 字段，图片 base64 替换为路径提示；当轮内存仍保留原始图片。普通文本和工具结果仍可能包含敏感内容，不能把这一步视为通用脱敏。启动时会用已知凭证值清洗历史，完成后才接收新消息。

## 清理

- 启动时、之后每天清理一次。
- 会话目录树最新 mtime 超过 7 天，整体删除；不单独删除仍在使用的会话里的旧附件。
- 消息状态按更新时间保留 7 天；启动时另清理超过 1 小时的 processing 标记。
- 消息认领对 processing 使用 10 分钟 TTL，failed 消息允许重试；不是跨进程 exactly-once。
- 空闲超过 24 小时的 Pi 会话从内存驱逐，下次从文件恢复。
- 用户缓存、个人记忆、凭证、定时任务和会话索引不按上述 7 天规则删除。

JSON 索引、消息状态和定时任务由进程内存管理并原子写回。服务运行期间不要直接编辑这些文件，也不要让多个实例共用同一数据目录。停服后再手工维护。

## 备份与恢复

保留历史需要同时备份 `data/` 和 `work_space/`。凭证恢复需要 vault 文件和 `data/.vault-key` 成对保存；主密钥损坏不会自动覆盖生成新密钥。加密防护不等于主机隔离：持有主密钥和库文件的人能解密凭证。

更换机器或工程绝对路径后，应检查 `sessions.json` 中的路径；现有索引包含绝对路径，不能保证直接搬迁后无缝续聊。环境配置单独备份并限制访问。
