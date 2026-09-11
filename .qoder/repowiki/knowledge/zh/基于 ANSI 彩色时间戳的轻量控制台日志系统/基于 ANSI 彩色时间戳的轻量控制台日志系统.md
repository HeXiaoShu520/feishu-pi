---
kind: logging_system
name: 基于 ANSI 彩色时间戳的轻量控制台日志系统
category: logging_system
scope:
    - '**'
source_files:
    - src/utils/logger.ts
    - src/feishu/log-utils.ts
    - src/main.ts
    - src/config-server.ts
    - src/feishu/admin-resolver.ts
    - src/feishu/agent-bridge.ts
    - src/feishu/cardkit-stream.ts
    - test/unit/log-utils.test.ts
---

## 1. 使用的系统/方案

本项目没有引入第三方日志框架（如 winston、pino、bunyan），而是实现了一个极简的本地 `logger` 模块（`src/utils/logger.ts`），直接包装 Node.js 原生 `console.info/warn/error/log`，为所有输出统一添加 `[YYYY-MM-DD HH:mm:ss]` 时间戳前缀和 ANSI 颜色标记。该 logger 同时提供语义化方法：`info`、`warn`、`error`、`log`、`userInput`（蓝色用户输入）、`aiResponse`（绿色 AI 响应）。

辅助工具位于 `src/feishu/log-utils.ts`，仅提供 `formatLogText(text, maxLength)` 用于截断并清洗换行符，以便将长文本安全地写入飞书卡片或日志摘要中。

## 2. 关键文件与包

- `src/utils/logger.ts` — 全局日志门面，导出 `colors` 常量与 `logger` 对象。
- `src/feishu/log-utils.ts` — 日志文本格式化（去换行、限长）。
- `src/main.ts` — 服务启动入口，集中使用 `logger` 记录初始化、清理、授权回调、优雅退出等关键流程。
- 各业务模块通过 `import { logger } from "../utils/logger.ts"` 引入并使用，例如：
  - `src/config-server.ts`：配置服务器启动日志。
  - `src/feishu/admin-resolver.ts`：管理员 Open ID 解析过程日志。
  - `src/feishu/agent-bridge.ts`：指令执行、卡片发送、错误处理日志。
  - `src/feishu/cardkit-stream.ts`：流式卡片相关日志。

## 3. 架构与约定

- **单例门面**：所有模块共享同一个 `logger` 实例，不传递 logger 参数，属于隐式全局依赖。
- **结构化字段**：日志采用“模块标签 + 消息”的伪结构化方式，在每条消息开头用方括号标注来源模块，如 `[Main]`、`[DataCleaner]`、`[AdminResolver]`、`[Command]`、`[Bridge]`、`[ConfigServer]`，便于在终端快速过滤。
- **级别策略**：仅使用 `info` / `warn` / `error` 三级；`info` 用于正常业务流程（会话清理统计、模型切换、授权结果等），`warn` 用于可恢复异常或废弃配置提示（如 `FEISHU_CMD_WHITELIST 已废弃`），`error` 用于不可恢复错误（如 CardKit 错误、命令执行失败、无法解析管理员标识）。
- **用户/AI 对话区分**：通过 `userInput(userName, message)` 和 `aiResponse(userName, message)` 以不同颜色区分用户输入与 AI 回复，便于交互式调试。
- **无持久化 sink**：日志仅输出到标准输出/错误流，未配置文件落盘、远程收集或按级别分文件；生产部署需依赖容器 stdout/stderr 收集。
- **测试覆盖**：`test/unit/log-utils.test.ts` 对 `formatLogText` 进行单元测试，验证换行去除与长度截断行为。

## 4. 约定与约束

- **时间格式固定**：所有日志统一使用 `YYYY-MM-DD HH:mm:ss` 格式，由内部 `timestamp()` 生成，不允许模块自行拼接时间。
- **颜色编码固定**：`gray` 用于时间戳、`yellow` 用于 warn、`red` 用于 error、`blue` 用于用户输入、`green` 用于 AI 响应、`cyan/magenta/bright` 保留但未在当前代码中使用。
- **日志来源标签**：每个调用点应在消息开头用 `[模块名]` 标注来源，这是仓库内实际遵循的约定（见 main.ts、admin-resolver.ts、agent-bridge.ts 等）。
- **长文本必须截断**：当日志内容可能包含换行或超长字符串时，应通过 `formatLogText(text, maxLength)` 处理后再输出，避免破坏终端或飞书卡片渲染。
- **禁止绕过 logger 直接 console**：当前仓库中所有业务日志均通过 `logger` 输出，未发现直接使用 `console.log/info/warn/error` 的业务代码（grep 结果为 0 匹配），表明 logger 是唯一的日志出口。
- **无动态级别开关**：日志级别在编译期固定，不支持运行时调整；若需降低噪音，只能修改源码注释掉对应调用。
- **敏感信息**：当前实现未做脱敏，日志中直接输出 Open ID、错误堆栈等，部署时需确保日志接收端具备访问控制。

## 5. 适用性说明

本仓库存在明确的日志子系统（`src/utils/logger.ts` + `src/feishu/log-utils.ts`），但它是面向开发/调试的轻量控制台日志，不具备结构化 JSON 输出、分级文件滚动、远程聚合等生产级特性。因此该类别**适用**，但成熟度为 **medium**：有统一的门面和约定，但功能简单、无持久化 sink、无动态配置。