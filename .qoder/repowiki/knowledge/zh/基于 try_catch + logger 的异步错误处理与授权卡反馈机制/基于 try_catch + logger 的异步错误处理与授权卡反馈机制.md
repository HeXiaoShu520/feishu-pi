---
kind: error_handling
name: 基于 try/catch + logger 的异步错误处理与授权卡反馈机制
category: error_handling
scope:
    - '**'
source_files:
    - src/utils/logger.ts
    - src/main.ts
    - src/feishu/lark-transport.ts
    - src/guard/broker.ts
    - src/guard/tool-guard.ts
    - src/permission/policy.ts
    - src/config-server.ts
---

## 1. 整体方法

该仓库没有统一的异常类型体系、错误码枚举或中间件框架。错误处理采用 **轻量级约定**：
- 所有 I/O、网络调用（飞书 SDK、文件读写、Express 路由）均使用 `try/catch` 包裹；
- 捕获的错误统一通过 `src/utils/logger.ts` 的 `logger.error` / `logger.warn` 输出，附带 `[模块名]` 前缀以便定位；
- 对“可恢复”的错误（如卡片更新失败、附件下载失败、策略文件解析失败）记录 warn/error 后继续执行；
- 对“不可恢复”的错误（如发送卡片缺少 message_id）直接 `throw new Error(...)` 向上冒泡；
- 无 `panic/recover` 概念（Node.js），也未注册 `unhandledRejection` / `uncaughtException` 全局处理器。

## 2. 关键文件与职责

| 文件 | 错误处理职责 |
|---|---|
| `src/utils/logger.ts` | 唯一日志出口，提供带 ANSI 颜色和时间戳的 `info/warn/error/log/userInput/aiResponse` |
| `src/main.ts` | 启动期异常（获取 Bot Open ID、优雅退出时断开连接）用 try/catch + `logger.warn`；进程信号处理中区分成功/失败路径 |
| `src/feishu/lark-transport.ts` | WebSocket 事件回调内层 try/catch 保证单条消息失败不阻塞后续事件；卡片回调、附件下载、会话模式查询等分支均有独立 catch |
| `src/guard/broker.ts` | 授权卡生命周期（发送失败、转发失败、结果卡更新失败）全部 `.catch(logger.warn)`，不会中断主流程 |
| `src/permission/policy.ts` | 策略文件缺失/JSON 解析失败时 fail-safe 回退到空组，仅首次 warn 一次避免刷屏 |
| `src/config-server.ts` | Express 每个路由单独 try/catch，返回 HTTP 500 + 错误信息文本 |

## 3. 架构与约定

### 3.1 事件驱动的错误隔离
`LarkTransport.connect()` 注册的 `im.message.receive_v1` 和 `card.action.trigger` 两个事件处理器内部各自 try/catch，确保某条消息归一化失败不会影响后续事件消费。消息分发后以 `void handler().catch(...)` fire-and-forget，由 `ConversationManager` 保证会话内顺序，而非在传输层等待。

### 3.2 授权卡作为用户可见的错误/确认通道
当工具调用被权限策略拒绝时，`ToolGuard` 不抛错，而是调用 `PermissionBroker.requestApproval` 发送授权卡片；若无法发卡（无 chatId），则返回 `{ block: true, reason }` 给上层。授权卡回调经 `handleCallback` 在服务端校验 token/chatId/管理员身份，任一不合法即拒绝并记录 detail。超时、会话中断（AbortSignal）、转发失败等状态统一通过 `finalizeCards` 撤回或更新为结果卡。

### 3.3 降级与回退
- 卡片更新优先按 `messageId` 持久更新，失败回退到临时 token 更新；
- 会话模式查询失败默认按普通群处理；
- 策略文件加载失败回退为空组（保守默认）；
- 优雅退出时断开飞书连接失败也不阻塞进程退出，仅 500ms 宽限期后 `process.exit(0)`。

### 3.4 安全相关错误
- 附件文件名经 `sanitizeFileName` 过滤 `/\:*?"<>|` 防止路径逃逸；
- bash 命令命中 shell 元字符（`;&|` 反引号 `$(`）时不参与白名单匹配，强制走授权卡；
- 配置服务器仅监听 `127.0.0.1`，注释明确“接口明文返回 App Secret，不能暴露到局域网”。

## 4. 约定与约束

- **每个外部调用点必须 try/catch**：代码中几乎所有 `client.request`、`readFile/writeFile`、`sendCardToChat` 都包裹了 try/catch，未捕获错误会向上传播。
- **禁止静默吞错**：捕获后必须通过 `logger.error` / `logger.warn` 记录，且带上 `[模块名]` 前缀（如 `[LarkTransport]`、`[Broker]`、`[Policy]`）。
- **可恢复错误走 warn，致命错误 throw**：例如 `sendCardToChat` 响应缺 `message_id` 时 `throw new Error`；而卡片更新失败仅 warn 并尝试回退方案。
- **用户可见错误通过卡片反馈**：非管理员点击模型切换、授权请求失效、转发失败等场景，都会调用 `updateCardById` 或 `buildNoticeCard` 在会话中展示提示，而不是仅写日志。
- **策略文件容错**：`.agent/permissions.json` 缺失或非法时按空组处理，只 warn 一次，新会话生效，避免服务因配置问题崩溃。
- **无全局错误处理器**：未发现 `process.on('unhandledRejection')` 或 `process.on('uncaughtException')` 注册，依赖各模块自行兜底。
- **HTTP 层统一返回格式**：配置服务器的每个路由 catch 后返回 `status 500` + 中文错误描述字符串，统计接口返回 `{ error }` JSON 结构。