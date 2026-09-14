---
kind: logging_system
name: 基于自定义 logger 的终端彩色日志系统
category: logging_system
scope:
    - '**'
source_files:
    - src/utils/logger.ts
    - src/feishu/log-utils.ts
    - src/main.ts
    - src/config-server.ts
    - src/feishu/agent-bridge.ts
    - src/feishu/admin-resolver.ts
    - src/feishu/cardkit-reply.ts
    - test/unit/log-utils.test.ts
---

## 1. 使用的系统与框架

本项目没有引入第三方日志库（如 winston、pino、bunyan），而是实现了一个轻量级的**自研日志工具**，位于 `src/utils/logger.ts`。该工具直接包装 Node.js 的 `console.info/warn/error/log`，为所有输出统一添加 ANSI 彩色时间戳前缀，并提供语义化的方法：
- `logger.info(...)` — 通用信息日志（灰色时间戳）
- `logger.warn(...)` — 警告日志（黄色 `[warn]` 标签）
- `logger.error(...)` — 错误日志（红色 `[error]` 标签）
- `logger.log(...)` — 普通日志（仅带灰色时间戳）
- `logger.userInput(userName, message)` — 用户输入（蓝色用户名标签）
- `logger.aiResponse(userName, message)` — AI 响应（绿色用户名标签）

此外，`src/feishu/log-utils.ts` 提供 `formatLogText(text, maxLength)` 辅助函数，用于在日志中截断过长文本并去除换行符，避免破坏日志格式。

## 2. 关键文件

- `src/utils/logger.ts` — 日志核心实现（时间戳生成、ANSI 颜色常量、导出 `logger` 对象）
- `src/feishu/log-utils.ts` — 日志文本格式化辅助
- `src/main.ts` — 应用入口，集中使用 `logger` 记录启动、清理、授权回调、优雅退出等关键流程
- `src/config-server.ts` — 配置服务器模块，也通过 `import { logger }` 复用同一日志器
- `src/feishu/agent-bridge.ts`、`src/feishu/admin-resolver.ts`、`src/feishu/cardkit-reply.ts` — 业务模块广泛调用 `logger` 记录指令执行、管理员解析、CardKit 流式处理等事件

## 3. 架构与约定

- **单一日志源**：全项目仅通过 `./utils/logger.ts` 暴露 `logger` 对象，所有模块通过相对路径导入，不存在多个日志实例或全局单例。
- **结构化字段以字符串拼接为主**：日志消息采用模板字符串 + 方括号前缀标识来源（如 `[Main]`、`[DataCleaner]`、`[AdminResolver]`、`[Bridge]`、`[Command]`、`[CardKit]`），而非 JSON 结构化字段。这便于人类阅读终端输出，但不利于机器解析。
- **无日志级别过滤**：当前实现未根据环境变量或配置文件动态调整日志级别；所有 `info/warn/error/log` 均直接输出到标准输出/错误流。
- **无日志轮转/持久化**：日志仅输出到控制台，不写入文件或外部 sink。需要持久化的审计数据通过独立的 JSONL 文件存储（如 `data/stats/skill-usage.jsonl`），不属于本日志系统范畴。
- **颜色与终端适配**：ANSI 颜色码硬编码在 `colors` 对象中，适用于支持 ANSI 的终端环境。

## 4. 约定与约束

- **来源标识约定**：每条日志消息开头使用 `[模块名]` 形式的标签（如 `[Main]`、`[DataCleaner]`、`[AdminResolver]`、`[Bridge]`、`[Command]`、`[CardKit]`），便于在终端中快速定位日志来源。
- **敏感信息脱敏**：`log-utils.formatLogText` 强制去除换行并将超长文本截断至默认 100 字符，防止日志被注入或刷屏。
- **用户/AI 交互专用通道**：用户输入和 AI 响应分别通过 `userInput` 和 `aiResponse` 两个专用方法输出，并使用不同颜色区分，形成统一的对话日志风格。
- **错误处理中的日志模式**：在 `main.ts` 的优雅退出流程中，异步断开飞书连接时使用 `.then(success => info, err => warn)` 的模式记录成功与失败，体现“非阻塞关闭”的约定。
- **测试覆盖**：`test/unit/log-utils.test.ts` 对 `formatLogText` 进行单元测试，确保日志文本格式化行为稳定。

## 5. 局限性与观察

- 由于是纯控制台输出，无法按级别过滤（例如生产环境只输出 warn/error），也不支持结构化查询或远程收集。
- 日志格式依赖 ANSI 颜色，在 CI 或非交互式环境中可能显示异常。
- 没有统一的 traceId/correlationId 机制，跨模块调用的上下文关联需依赖人工拼装的 `[模块名]` 标签。
- 该项目属于轻量级飞书 Agent 应用，日志系统的设计目标明确为“可读性优先”，而非可观测性基础设施。