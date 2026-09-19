# 机器人命令

私聊直接发送；群聊需要 @机器人。命令由服务处理，不经过模型工具循环。

| 命令 | 行为 |
|---|---|
| `/help` | 查看帮助 |
| `/model` | 从配置的模型接口查询模型列表，切换按钮仅管理员可操作 |
| `/new` | 新建一代会话，旧目录保留至过期清理；话题内禁用，普通群会重置共享历史 |
| `/stop` | 中断当前会话生成 |
| `/detail` | 查看当前详细/精简模式 |
| `/detail on` / `/detail off` | 按 chatId 切换回复模式，重启后恢复默认精简 |
| `/login` / `/login lark` | 私聊发起飞书用户授权 |
| `/login meegle` | 私聊发起飞书项目授权 |
| `/status` | 查看本人登录状态和身份组 |
| `/logout` / `/logout all` | 清除本人已接入 provider 的本地凭证 |
| `/logout lark` / `/logout meegle` | 仅清除指定 provider 的凭证 |

`/model` 需要配置 `FEISHU_PI_MODEL_BASE_URL`；切换会写回 `.env`，新建或重建的 Pi 会话使用新模型。现存会话可在允许的场景使用 `/new` 更新。

没有 `/perm`、`/stats`、`/schedule` 命令。权限查看使用配置文件与 `/status`；定时任务通过自然语言调用 `schedule_manager`，是否可调用由 `Tools(schedule_manager)` 决定。

登录也可由缺凭证/缺 scope 的 CLI 调用自动发起，授权链接发往本人私聊。`/logout` 清除本地凭证，不撤销飞书服务器端已授予的应用权限。
