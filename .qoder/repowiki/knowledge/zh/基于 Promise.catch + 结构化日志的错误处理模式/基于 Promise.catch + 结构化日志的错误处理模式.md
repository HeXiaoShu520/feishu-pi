---
kind: error_handling
name: 基于 Promise.catch + 结构化日志的错误处理模式
category: error_handling
scope:
    - '**'
source_files:
    - src/utils/logger.ts
    - src/feishu/lark-transport.ts
    - src/guard/broker.ts
    - src/main.ts
    - src/runtime/conversation-manager.ts
    - src/feishu/log-utils.ts
---

## 1. 整体方案

仓库没有自定义错误类型体系、全局异常中间件或 panic/recover。错误处理采用 **轻量级 Promise 风格**：在关键异步边界用 `try/catch` 包裹，失败时通过统一的 `logger`（`utils/logger.ts`）输出带时间戳和颜色前缀的日志，并以 `.catch(() => {})` 或 `void handler().catch(...)` 的方式实现 fire-and-forget，避免未捕获拒绝导致进程崩溃。

## 2. 关键文件与职责

- `src/utils/logger.ts`：唯一日志出口，提供 `info/warn/error/log/userInput/aiResponse` 五个级别，所有日志自动加 `[YYYY-MM-DD HH:mm:ss]` 前缀，error 使用红色 `[error]` 标记。
- `src/feishu/lark-transport.ts`：飞书 WebSocket 传输层，是错误收敛的核心节点——消息归一化、卡片回调、附件下载等全部有独立 try/catch，失败仅记日志不向上抛。
- `src/guard/broker.ts`：授权中枢 `PermissionBroker`，对卡片发送/更新/撤回等外部调用统一 `.catch` 并记录 warn；超时、取消、非法回调以 `{ accepted: false, detail }` 结构返回而非抛错。
- `src/main.ts`：服务启动入口，集中处理 SIGINT/SIGTERM/SIGBREAK 优雅退出，断开连接失败仅 warn，500ms 宽限期后强制 `process.exit(0)`。
- `src/runtime/conversation-manager.ts`：会话队列中 `state.queue = task.catch(() => undefined)` 吞掉单个请求异常，保证后续消息继续执行。
- `src/feishu/log-utils.ts`：辅助函数 `formatLogText` 用于截断日志文本，避免长堆栈刷屏。

## 3. 架构约定

### 3.1 事件总线式错误隔离
`LarkTransport.connect()` 注册 SDK 事件处理器时，每个 handler 内部都包一层 try/catch：
- `im.message.receive_v1`：归一化/分发失败 → `logger.error`，不影响其他消息。
- `card.action.trigger`：回调处理失败 → `logger.error`，仍返回 ACK toast 避免 SDK 报超时。
- `dispatchMessage` 调用上层 `handler` 时用 `void handler().catch(...)`，确保消息处理链中的任何异常不会阻塞 SDK 事件循环。

### 3.2 卡片回调的降级策略
`updateCard` 方法先尝试按 `messageId` 持久更新（`im.v1.message.patch`），失败则回退到基于回调 token 的临时更新（`/interactive/v1/card/update`），再失败只记 warn 不抛错。这保证了即使飞书 API 部分不可用，用户交互仍能继续。

### 3.3 授权流程的状态机式错误
`PermissionBroker` 不抛错，而是返回 `{ allowed, detail }` / `{ accepted, detail }` 结构体，detail 字段描述具体原因（如“未配置管理员”“token 或卡片来源不匹配”“仅管理员可操作”“该授权请求不存在或已处理”）。调用方根据 `accepted`/`allowed` 分支处理，并在需要时就地更新卡片提示（如失效授权卡显示 `APPROVAL_STALE_NOTICE`）。

### 3.4 资源下载的幂等容错
`downloadFileAttachments` 逐个附件 try/catch，单个失败只记 warn，其余继续；最多处理 5 个附件，防止一次消息携带过多附件拖垮进程。

### 3.5 进程级优雅退出
`main.ts` 监听 `SIGINT`/`SIGTERM`/`SIGBREAK`，关闭定时器、停止调度服务、后台断开 WS 连接（不 await，挂住也不阻塞），500ms 后 `process.exit(0)`。Windows 上因 WS disconnect 可能挂住，所以强制退出是必要兜底。

## 4. 约束与规则

- **禁止未捕获 Promise 拒绝**：所有对外部 SDK（飞书 Client、WSClient）的调用要么被 await 且外层有 try/catch，要么用 `.catch(logger.warn|error)` 显式吞掉。
- **业务逻辑错误用返回值表达**：`PermissionBroker`、`AskBroker` 等核心组件不抛错，改用结构化结果对象，使调用方能区分“系统错误”和“业务拒绝”。
- **日志必须带上下文标签**：所有 logger 调用使用 `[模块名]` 前缀（如 `[LarkTransport]`、`[Broker]`、`[Main]`），便于在终端快速定位。
- **用户可见错误走卡片/文本反馈**：非致命错误（如卡片更新失败、模型切换失败）优先通过 `sendTextToChat` 或就地更新卡片告知用户，而不是仅记录日志。
- **无全局错误中间件**：错误处理分散在各模块边界，依赖调用方自行 catch；没有类似 Express 的 `next(err)` 模式。
- **无自定义 Error 子类**：代码中未见 `class XxxError extends Error` 定义，所有异常均为原生 `Error` 或任意值（通过 `error instanceof Error ? error.message : String(error)` 安全取消息）。

## 5. 适用性说明

该模式适用于本仓库作为“飞书 Agent 运行时”的定位：以 WebSocket 长连接为入口，大量异步 I/O（飞书 API、文件系统、AI 模型调用），需要高可用且不中断主循环。其代价是缺少统一错误码、错误上报链路和细粒度错误分类，但在当前规模下足够简洁可靠。