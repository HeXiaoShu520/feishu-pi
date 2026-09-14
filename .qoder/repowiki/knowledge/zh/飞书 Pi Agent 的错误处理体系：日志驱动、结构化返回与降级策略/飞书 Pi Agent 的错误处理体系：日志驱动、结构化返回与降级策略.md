---
kind: error_handling
name: 飞书 Pi Agent 的错误处理体系：日志驱动、结构化返回与降级策略
category: error_handling
scope:
    - '**'
source_files:
    - src/utils/logger.ts
    - src/main.ts
    - src/feishu/lark-transport.ts
    - src/guard/broker.ts
    - src/guard/judge.ts
    - src/runtime/feishu-pi-runtime.ts
---

## 1. 整体方案

该仓库没有统一的错误类型库或全局异常中间件，而是采用**“结构化返回值 + 统一 logger + 失败降级”**的轻量模式：
- 所有可恢复的异步调用（飞书 API、文件 IO、网络请求）通过 `try/catch` 捕获，记录到 `src/utils/logger.ts` 提供的带时间戳彩色前缀日志（`info/warn/error/userInput/aiResponse`），不向上抛出。
- 不可恢复的配置/初始化错误（如缺少 `FEISHU_PI_MODEL_API_KEY`、找不到模型）直接 `throw new Error(...)`，由进程入口 `main.ts` 暴露给 Node 运行时终止。
- 对外部依赖的失败普遍采用 **fail-safe 降级**：审核模型调用失败 → 回退为 `ask`；卡片更新失败 → 回退到 token 临时更新；附件下载失败 → 仅记 warn 并继续处理消息。

## 2. 关键文件与职责

| 文件 | 错误处理职责 |
|---|---|
| `src/utils/logger.ts` | 唯一日志出口，提供 `info/warn/error/userInput/aiResponse`，所有错误最终落盘到此 |
| `src/main.ts` | 进程级优雅退出（SIGINT/SIGTERM/SIGBREAK），连接断开失败仅 warn 后强制退出 |
| `src/feishu/lark-transport.ts` | WebSocket 事件归一化、卡片回调、消息分发、资源下载的集中错误捕获点 |
| `src/guard/broker.ts` | 授权卡生命周期管理：发送/更新/撤回失败均 `.catch(logger.warn)`，超时/取消走结构化拒绝 |
| `src/guard/judge.ts` | 智能体审核：HTTP 非 200 / JSON 解析失败 / fetch 异常全部回退为 `ask` |
| `src/runtime/feishu-pi-runtime.ts` | 工具调用前置钩子：Guard 异常按拒绝处理，技能统计失败仅 warn |
| `src/config-server.ts` | 本地配置页面服务（启动即监听 3456，错误未单独捕获） |

## 3. 架构与约定

### 3.1 错误分类与传播边界

- **配置/启动期错误**：在 `FeishuPiRuntime.createSession` 中校验 `FEISHU_PI_MODEL_API_KEY` 和模型存在性，直接 `throw new Error`，由 `main()` 顶层 await 暴露，进程崩溃。
- **运行时可恢复错误**：一律 catch 后 `logger.warn/error`，不中断当前消息处理。例如 `LarkTransport.dispatchMessage` 外层 try/catch 包裹用户资料查询、图片处理、附件下载等步骤，任一失败只记日志，消息仍继续下发。
- **外部回调错误**：卡片回调处理器 `handleCardAction` 内部 try/catch，解析 value 失败时 `logger.warn` 并跳过，不影响 ACK 响应。

### 3.2 结构化返回值替代 throw

`PermissionBroker` 是典型代表：所有方法返回 `{ accepted: boolean; detail: string }` 而非抛错。调用方根据 `accepted` 分支处理，`detail` 携带人类可读原因（如 `"token 或卡片来源不匹配"`、`"仅管理员可操作"`）。这种设计使授权流程在卡片失效、转发失败、参数非法等场景下都能优雅降级。

### 3.3 降级策略矩阵

| 场景 | 降级行为 |
|---|---|
| 获取 Bot Open ID 失败 | `logger.warn`，继续启动（botOpenId 可选） |
| 会话模式查询失败 | `logger.warn`，默认按普通群处理 |
| 附件下载失败 | `logger.warn`，继续处理文本 |
| 卡片持久更新失败 | 回退到 card token 临时更新 |
| 审核模型 HTTP 非 200 | 返回 `{ decision: "ask", reason: "审核接口异常" }` |
| 审核模型 JSON 解析失败 | 返回 `{ decision: "ask", reason: "无法解析" }` |
| 审核模型 fetch 异常 | `logger.warn` 后返回 `ask` |
| 技能使用统计写入失败 | `logger.warn`，不阻塞工具执行 |
| 授权卡发送失败 | 立即 resolve 等待方为 false，释放 pending 队列 |
| 授权卡撤回/更新失败 | `logger.warn`，不影响主流程 |
| 优雅退出时断开连接失败 | `logger.warn`，500ms 后 `process.exit(0)` |

### 3.4 安全相关错误

- 文件名清洗：`sanitizeFileName` 过滤路径分隔符等危险字符，防止下载路径逃逸。
- 卡片回调服务端校验：`broker.handleCallback` 强制校验 `approvalId/token/chatId/messageId/operatorOpenId` 一致性，任一不合法即拒绝，避免重放攻击。
- 非管理员点击卡片：`lark-transport.ts` 中检测 `operatorOpenId !== adminOpenId`，就地更新卡片提示“仅管理员可执行此操作”。

## 4. 约定与约束

- **禁止吞掉未记录的异常**：所有 `catch` 块必须调用 `logger` 的对应级别方法，不允许静默忽略（代码中未发现裸 catch）。
- **fire-and-forget 回调必须显式 .catch**：`void this.handler?.(...).catch(...)` 模式用于后台处理，确保未捕获异常不会导致事件循环崩溃。
- **超时统一用 AbortController/Timeout**：`PolicyJudge` 使用 `AbortController` 配合 `setTimeout` 控制审核请求超时；`PermissionBroker.requestApproval` 使用 `setTimeout` 实现授权卡超时拒绝。
- **无全局 error handler**：未注册 `process.on('uncaughtException')` 或 `unhandledRejection`，依赖 Node 默认行为终止进程——这与“启动期错误直接 throw”的策略一致。
- **无自定义 Error 子类**：全仓未定义业务错误类型，统一使用原生 `Error`，通过 `error instanceof Error ? error.message : String(error)` 做安全取值。
- **用户可见错误通过卡片反馈**：对用户的错误（如权限不足、模型切换失败）优先以 CardKit 卡片形式就地更新，而非仅打印日志。

## 5. 适用性判断

本仓库虽无传统意义上的“错误框架”，但形成了清晰一致的错误处理约定：**日志驱动 + 结构化返回值 + 多层降级**，覆盖传输层、权限守卫、运行时、调度器等核心模块，属于中等成熟度的错误处理体系。