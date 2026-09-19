# feishu-pi

基于 Pi AgentSession 的飞书智能体服务。Pi 负责模型与工具循环，本工程负责飞书消息、会话、身份授权、权限审核和定时任务。

## 启动

需要 Node.js 22+、npm，以及可用的模型接口。Python 仅在使用 Python 自定义工具时需要。

```sh
npm ci
npm run setup
npm start
```

`npm run setup` 可扫码创建或更新飞书应用；`npm run setup -- --new` 创建新应用。首次启动缺少应用凭据时，交互终端也会进入向导。首次用户授权需要交互终端；部署为后台服务前先完成初始化。向导不代填模型密钥。

配置项见 [.env.example](.env.example)：

| 配置 | 用途 |
|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书应用凭据 |
| `FEISHU_PI_MODEL_NAME` / `FEISHU_PI_MODEL_API_KEY` | 模型名称与密钥 |
| `FEISHU_PI_MODEL_BASE_URL` | 模型接口地址，可选 |
| `FEISHU_PI_THINKING_LEVEL` | `off` / `low` / `high` / `max`，默认 `off` |
| `FEISHU_PI_ADMIN` | 管理员标识，推荐使用稳定的 openId |
| `FEISHU_PI_GROUP` / `FEISHU_PI_GROUP_<组名>` | 身份组成员 |
| `FEISHU_GUARD_BASE_URL` / `FEISHU_GUARD_MODELS` / `FEISHU_GUARD_API_KEY` | 可选审核模型；未配置时策略外调用走授权卡 |
| `FEISHU_USER_AUTH_SCOPES` | 覆盖默认用户授权 scope，以空格或逗号分隔 |
| `FEISHU_SHOW_MODEL_STATS` | 回复统计小字开关，默认开启，设 `0` 关闭 |

应用需要启用机器人与长连接，订阅 `im.message.receive_v1` 和 `card.action.trigger`。初始化向导提供预置权限；应用实际生效的权限以飞书后台发布状态为准。

## 当前能力

- 私聊全部响应；群聊只响应 @机器人的消息。
- 文本、图片和文件附件；CardKit 2.0 流式回复、工具状态、详细/精简显示。
- 私聊按 chatId 保存历史，普通群全群共享，话题群按话题共享。共享历史中的工具身份始终属于本轮发言人。
- 用户飞书授权与飞书项目授权，按 openId 加密保存凭证。
- `deny` + 身份组 `allow` 策略、审核模型与单次人工授权。
- 个人文件记忆、定时任务和 Markdown 技能；TS/JS/Python 自定义工具。
- 消息去重、会话恢复、空闲驱逐与过期目录清理。

当前没有 HTTP 服务、`/stats` 页面、技能使用统计 API 或 `/perm` 命令。

## 开发与扩展

```sh
npm run dev     # 源码热重载
npm run check   # TypeScript 检查
npm test        # Vitest 测试
```

| 位置 | 职责 |
|---|---|
| `src/main.ts` | 服务装配与启动 |
| `src/feishu/` | 消息、卡片、用户资料和授权 |
| `src/runtime/` | Pi 适配、会话队列、持久化和清理 |
| `src/permission/`、`src/guard/` | 策略与工具调用审核 |
| `src/schedule/` | 定时任务服务和管理工具 |
| `.agent/` | 系统提示、技能、权限与自定义工具 |
| `test/` | 回归测试 |

通用行为约束写在 `.agent/SYSTEM.md`；工具使用策略写在工具 `description`；技能负责业务流程说明，不承载权限。系统提示、技能和工具加载后缓存在进程内，修改需重启。权限文件按 mtime 在每次工具调用时重新检查。

依赖声明中 Pi、飞书 SDK 和 CLI 使用 `latest`，实际安装版本由 `package-lock.json` 锁定；部署使用 `npm ci`。升级依赖后需要回归消息、附件、授权卡和模型切换。

详细说明：[架构](docs/architecture.md) · [命令](docs/commands.md) · [授权](docs/user-auth.md) · [数据](docs/data-management.md) · [工具扩展](.agent/README.md)。
