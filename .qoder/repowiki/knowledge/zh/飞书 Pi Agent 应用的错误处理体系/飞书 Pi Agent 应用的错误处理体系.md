---
kind: error_handling
name: 飞书 Pi Agent 应用的错误处理体系
category: error_handling
scope:
    - '**'
source_files:
    - src/feishu/agent-bridge.ts
    - src/utils/logger.ts
    - src/config-server.ts
    - src/config.ts
    - src/guard/broker.ts
    - src/permission/policy.ts
    - src/feishu/admin-resolver.ts
    - src/main.ts
    - src/runtime/conversation-manager.ts
---

## 1. 整体方案

该仓库是一个基于 Node.js ESM + TypeScript 的飞书智能体应用，**没有引入统一的异常类型库或全局错误码枚举**。错误处理以“原生 `Error` + `try/catch` + 结构化日志”为主，辅以面向业务场景的专用组件（授权 Broker、权限策略、配置服务器）来收敛特定领域的失败路径。

- **启动期校验失败**：通过抛出 `Error` 让进程快速失败（fail-fast），例如 `src/config.ts` 中 `loadConfig()` 对缺失的环境变量直接 `throw new Error(...)`。
- **运行时异步错误**：在消息处理链路（`FeishuAgentBridge.handle`）中使用 `try/catch/finally` 包裹整个 prompt→渲染→关闭流程，确保 spinner/定时器/reaction 等资源释放，并通过 `MessageStore.fail` 标记消息状态。
- **外部调用失败**：飞书 SDK、HTTP 请求等第三方调用普遍采用 `.catch((err) => logger.error(...))` 记录后继续或上抛，避免单点失败拖垮整条链路。
- **Web 接口层**：`config-server.ts` 使用 Express，每个路由用 `try/catch` 捕获并返回 `500` + 中文错误信息，不暴露堆栈。
- **无全局中间件**：未定义统一的全局错误处理器；Express 的错误由各自路由 `try/catch` 兜底。
- **无 `panic/recover` 概念**：Node.js 环境不使用 `process.on('uncaughtException')` 或 `unhandledRejection` 监听，所有异常都走显式 `catch`。

## 2. 关键文件与职责

| 文件 | 错误处理职责 |
|---|---|
| `src/config.ts` | 启动期必填环境变量缺失时抛 `Error`，强制配置完备性 |
| `src/utils/logger.ts` | 统一日志门面（`info/warn/error/userInput/aiResponse`），带时间戳和 ANSI 颜色，是错误上报的唯一出口 |
| `src/feishu/agent-bridge.ts` | 核心消息处理链路的 try/catch 中心：捕获 prompt/工具调用/卡片发送错误，写入 `reply.close(处理失败:...)`，再 `throw error` 上抛；命令执行失败仅记日志不中断 |
| `src/config-server.ts` | Express 路由级 `try/catch`，统一返回 `500` + 中文提示 |
| `src/guard/broker.ts` | 授权 Broker：超时拒绝、回调参数非法、token/来源不匹配、管理员校验失败等分支均返回 `{ accepted: false, detail }`，并在卡片收尾时 catch 更新失败 |
| `src/permission/policy.ts` | 权限策略文件解析失败时按保守默认（仅技能目录可读）降级，只 warn 一次 |
| `src/feishu/admin-resolver.ts` | 管理员 Open ID 解析各阶段失败均 `logger.warn` 并回退到下一步尝试，最终返回 `undefined` |
| `src/main.ts` | 优雅退出：SIGINT/SIGTERM/SIGBREAK 清理定时器、停止调度、断开连接（失败仅 warn），500ms 宽限期后 `process.exit(0)` |
| `src/runtime/conversation-manager.ts` | 会话队列：新消息打断在途响应（`session.abort()`），任务失败 `catch(() => undefined)` 防止队列阻塞 |

## 3. 架构与约定

### 3.1 分层错误传播

- **边界层（入口/传输）**：`main.ts` 负责进程级资源管理，内部错误通过 `logger.warn` 降级，不影响退出流程。
- **业务层（Bridge/Broker/Policy）**：`FeishuAgentBridge` 是用户消息处理的唯一入口，所有下游错误要么被消费（如 CardKit 流式更新失败仅记日志），要么被包装为人类可读文案后上抛。
- **基础设施层（Logger）**：所有错误最终落到 `logger.error`，格式固定为 `[timestamp] [error] ...`，便于日志系统聚合。

### 3.2 卡片/交互类错误的特殊处理

由于飞书卡片更新是异步且可能失败（网络抖动、消息过期），代码大量使用 `.catch(() => {})` 或 `.catch((err) => logger.error(...))` 忽略非致命错误，保证主流程不被 UI 更新失败阻断。例如：
- `reply.replace(...).catch(() => {})` 动画帧更新
- `finalizeCards` 中撤回/更新结果卡失败仅 `logger.warn`
- `transport.updateCardById(...).catch(() => {})` 失效授权卡就地更新

### 3.3 授权安全模型

`PermissionBroker` 实现了服务端强校验：回调必须满足 `approvalId` 存在、`token` 一致、消息来源匹配（原卡或转发卡）、操作者是管理员、决策值合法，任一不满足即拒绝并返回具体 `detail` 原因。这是该仓库最接近“错误码/错误类型”抽象的部分——以 `{ accepted, detail }` 对象表达授权结果。

### 3.4 配置与策略的 fail-safe

- `PermissionPolicy.ensureLoaded`：策略文件缺失/JSON 解析失败 → 清空组配置，按保守默认处理，仅第一次 warn。
- `admin-resolver.resolveAdminOpenId`：缓存读取、邮箱查询、姓名搜索任一失败 → 记录 warn 并继续尝试下一方案，最终返回 `undefined`。

## 4. 约定与约束

1. **禁止吞掉关键错误**：只有 UI 更新（卡片 replace/update/stats/close）等非核心副作用允许 `.catch(() => {})`；业务逻辑错误必须 `logger.error` 后上抛或返回明确失败结果。
2. **资源清理必须在 `finally`**：`agent-bridge.ts` 中 spinner 定时器、tool 动画定时器、reaction 移除均在 `finally` 中执行，确保 prompt 抛错时也能释放。
3. **用户可见错误必须本地化**：Express 路由返回的 500 响应使用中文（“读取配置失败”“保存配置失败”“读取统计数据失败”），不暴露内部堆栈。
4. **启动期错误即进程退出**：`loadConfig` 抛出的 `Missing required environment variable` 错误不会被捕获，由 Node 进程终止，符合 fail-fast 原则。
5. **授权回调不可信输入**：`handleCallback`/`forwardToAdmin` 对所有入参做白名单校验（decision 仅允许 `allow_once`/`deny`），非法输入直接拒绝。
6. **日志是唯一错误出口**：仓库未定义自定义 Error 子类或错误码常量，所有错误信息通过 `logger` 输出，测试中通过断言日志内容验证行为。