# 个人数据

运行数据和会话均不提交 Git。删除 `.git` 或更换远端不会删除这些数据。

| 路径 | 内容 |
|---|---|
| `data/memory/MEMORY.md` | 一份个人长期记忆 |
| `data/memory/archive/` | rewrite 前的记忆版本 |
| `data/memory/index.json` | 可重建的记忆与本人历史检索索引 |
| `data/tasks/tasks.json` | 后台任务记录 |
| `data/tasks/<id>/output.log` | 合并 stdout/stderr 的任务日志，最多 10 MiB |
| `data/browser/profile/` | 独立浏览器登录状态，不是日常 Edge 默认 profile |
| `data/browser/artifacts/` | 截图和页面产物 |
| `data/credentials/`、`data/.vault-key` | 本工程授权凭证和加密密钥 |
| `data/users/` | 本人及被提及人员的资料缓存 |
| `data/schedules.json` | 本人显式创建的定时任务 |
| `data/sessions.json` | 当前会话映射 |
| `work_space/<sessionId>/` | Pi 会话 jsonl、图片、附件与会话元数据 |

首次使用新记忆服务时，如果 `MEMORY.md` 不存在，只迁移本人的旧 `<openId>.md`，不会合并其他人的记忆。历史来源以 `session.json` 的 ownerOpenId 或旧 conversationId 的本人归属判断，不导入无法确认归属的旧群聊。

索引按需更新；已被清理的会话会从索引中移除。索引可以删除后重建。修改长期记忆不会删除会话原文；rewrite 保存旧版本归档。

后台任务记录跨重启保留，进程不能跨服务重启恢复。异常结束的任务显示 interrupted，不自动重跑。完成通知发送失败会写日志；记录可继续查询。

日志、记忆、截图和浏览器登录状态可能包含个人信息，应与电脑的其他私人数据一起管理。权限规则不替代操作系统文件权限。
