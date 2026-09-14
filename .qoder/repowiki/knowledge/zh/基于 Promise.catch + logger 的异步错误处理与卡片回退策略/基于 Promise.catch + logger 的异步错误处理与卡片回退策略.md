---
kind: error_handling
name: 基于 Promise.catch + logger 的异步错误处理与卡片回退策略
category: error_handling
scope:
    - '**'
source_files:
    - src/main.ts
    - src/feishu/lark-transport.ts
    - src/guard/broker.ts
    - src/feishu/cardkit-stream.ts
    - src/feishu/agent-bridge.ts
    - src/utils/logger.ts
    - src/config.ts
---

## 1. 整体方案

本仓库没有统一的异常类型体系或全局中间件，而是采用 **Promise 链式 `.catch()` + 结构化 `logger`** 的轻量错误处理方式。所有 I/O（飞书 WebSocket、HTTP API、文件读写）均通过 try/catch 或 `.catch()` 捕获，统一降级为日志记录并继续运行，保证 Agent 进程不因单个请求失败而崩溃。

- 日志：`src/utils/logger.ts` 提供带时间戳和 ANSI 颜色的 `info/warn/error/log/userInput/aiResponse` 方法，所有错误路径都通过 `logger.error` / `logger.warn` 输出，便于在终端定位问题。
- 无自定义 Error 子类：仅在配置校验、CardKit 初始化、模型切换等关键入口使用裸 `throw new Error(...)` 作为快速失败信号；业务层不定义领域错误类型。
- 无 `try...finally` 资源清理模式：资源释放集中在 `main.ts` 的优雅退出钩子（SIGINT/SIGTERM/SIGBREAK），通过 `process.exit(0)` 强制结束，WebSocket 断开操作以 fire-and-forget 方式执行，挂起也不阻塞退出。

## 2. 关键位置与职责

| 文件 | 错误处理职责 |
|---|---|
| `src/main.ts` | 启动期异常（获取 Bot Open ID、管理员解析）用 try/catch 记录 warn；授权回调失效时就地更新卡片提示；优雅退出关闭连接并定时硬退出 |
| `src/feishu/lark-transport.ts` | 消息归一化、卡片回调、附件下载、会话模式查询全部包裹 try/catch；WSClient 的 `onReconnecting/onReconnected/onError` 回调直接记日志；消息分发采用 fire-and-forget（`void handler().catch(...)`），失败仅记日志 |
| `src/guard/broker.ts` | 授权卡发送失败直接拒绝并唤醒等待方；超时/取消/转发失败统一走 `finalizeCards` 撤回或更新结果卡；所有卡片更新/撤回调用均以 `.catch(logger.warn)` 兜底 |
| `src/feishu/cardkit-stream.ts` | CardKit 流写入失败进入 `writeChain = next.catch(...)` 错误链，重试失败后降级为普通文本回复 |
| `src/feishu/agent-bridge.ts` | 用户输入/工具状态更新失败 `.catch(() => {})` 静默忽略；最终 `reply.close` 失败再记 error 日志 |
| `src/config-server.ts` | 本地配置页面 HTTP 路由的错误统一 catch 并返回 500 |
| `src/feishu/image-processor.ts` | 图片缓存/下载失败记录 warn，不影响主流程 |

## 3. 架构约定

1. **入站事件不可抛错**：`LarkTransport.connect` 中注册的事件处理器对 `normalize`、`dispatchMessage`、`handleCardAction` 的异常全部 catch 并 `logger.error`，确保 SDK 事件循环不被中断。
2. **fire-and-forget 处理**：消息处理通过 `void this.handler?.(...).catch(...)` 后台执行，避免阻塞 SDK 事件 ACK；顺序性由 `ConversationManager` 保证，去重由 `MessageStore.claim` 保证。
3. **卡片回退策略**：`updateCard` 优先按 `messageId` 持久更新，失败则回退到基于回调 token 的临时更新；授权卡最终一律在 `Broker.finalizeCards` 中根据精简/详细模式选择“撤回”或“更新为结果卡”。
4. **授权回调服务端校验**：`PermissionBroker.handleCallback` 强制校验 `approvalId/token/chatId/operatorOpenId` 四要素，任一不合法即返回 `{ accepted: false, detail }`，不在前端信任点击来源。
5. **优雅退出**：`main.ts` 同时监听 SIGINT/SIGTERM/SIGBREAK，先清定时器、停调度器，再后台断开 WS 并给 500ms 宽限期后 `process.exit(0)`，避免 Windows 上 WS disconnect 挂住进程。
6. **配置阶段快速失败**：`config.ts` 对缺失环境变量直接 `throw new Error('Missing required environment variable: ...')`，启动期不允许静默降级。

## 4. 约束与规则

- 所有外部 I/O 调用必须被 try/catch 或 `.catch()` 包裹，禁止未捕获的 Promise rejection 冒泡到事件循环。
- 对用户可见的错误（如卡片更新失败、授权卡发送失败）需通过飞书卡片就地更新提示（`buildNoticeCard` / `buildResultCard`），而非仅记录日志。
- 非关键路径失败（如图片下载、附件保存、卡片更新回退）应记录 warn 并继续执行，不得中断主流程。
- 授权相关回调必须在服务端完成身份与 token 校验，禁止信任客户端传递的决策值。
- 优雅退出必须实现，且不能因某个清理步骤失败而阻止进程退出。