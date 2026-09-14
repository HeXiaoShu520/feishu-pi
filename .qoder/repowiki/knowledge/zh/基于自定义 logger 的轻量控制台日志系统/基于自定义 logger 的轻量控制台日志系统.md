---
kind: logging_system
name: 基于自定义 logger 的轻量控制台日志系统
category: logging_system
scope:
    - '**'
source_files:
    - src/utils/logger.ts
    - src/feishu/log-utils.ts
    - test/unit/log-utils.test.ts
    - src/main.ts
---

## 1. 使用的系统/方案

本项目没有引入第三方日志框架（如 winston、pino、log4js），而是实现了一个极简的内置日志模块 `src/utils/logger.ts`，直接包装 Node.js 原生 `console.info/warn/error/log`，并统一添加 ANSI 彩色时间戳前缀。此外，`src/feishu/log-utils.ts` 提供纯文本格式化辅助函数 `formatLogText`，用于将多行长文本压缩为单行短串，便于写入飞书消息或卡片。

## 2. 关键文件
- `src/utils/logger.ts`：核心日志门面，导出 `logger` 对象及 `colors` 常量。
- `src/feishu/log-utils.ts`：日志文本清洗工具（去换行、截断）。
- `test/unit/log-utils.test.ts`：对 `formatLogText` 的行为进行单元测试。
- `src/main.ts`：应用入口，集中使用 `logger` 记录启动、清理、授权回调、优雅退出等关键流程日志。

## 3. 架构与约定

### 3.1 日志门面
`logger` 暴露以下方法：
- `info(...args)`：标准信息日志，输出灰色 `[YYYY-MM-DD HH:mm:ss]` 时间戳。
- `warn(...args)`：警告日志，额外附加黄色 `[warn]` 标签。
- `error(...args)`：错误日志，附加红色 `[error]` 标签。
- `log(...args)`：原始日志，仅带时间戳。
- `userInput(userName, message)`：用户输入专用，蓝色 `[用户名]` 标签。
- `aiResponse(userName, message)`：AI 响应专用，绿色 `[用户名]` 标签。

所有方法均通过 `console.*` 输出到标准输出，未做异步化、缓冲或落盘。

### 3.2 颜色与格式
- 时间戳由内部 `timestamp()` 生成，格式固定为 `YYYY-MM-DD HH:mm:ss`。
- 颜色通过 ANSI 转义码定义在 `colors` 对象中（gray/yellow/red/cyan/green/blue/magenta/bright/reset），每个日志调用都会拼接对应颜色的标签。
- 业务代码通过方括号前缀区分来源，例如 `[DataCleaner]`、`[Main]`、`[PermissionBroker]` 等，形成一种非正式的“模块名”约定。

### 3.3 日志级别策略
项目未实现可配置的日志级别开关。`logger` 同时提供 info/warn/error/log 四个通道，但全部直接输出到 stdout，不存在按环境变量过滤级别的逻辑。业务侧自行选择合适的方法（如启动阶段用 `info`，异常路径用 `error`，废弃配置提示用 `warn`）。

### 3.4 结构化字段
当前日志不是结构化 JSON 格式，而是人类可读的字符串拼接。唯一接近结构化的部分是方括号包裹的来源标签（如 `[DataCleaner] cleanupStuckMessages...`）。`formatLogText` 被用于把任意多行内容压缩成单行短串，以便安全地放入飞书卡片或消息体，避免换行破坏 UI。

### 3.5 输出目标（Sink）
所有日志直接写入进程标准输出（stdout/stderr），由运行环境（终端、PM2、Docker 等）负责收集。项目中未发现任何将日志重定向到文件、远程服务或监控平台的代码。

## 4. 约定与约束

- **统一入口**：所有日志必须通过 `src/utils/logger.ts` 导出的 `logger` 对象发出，禁止在业务模块内直接使用 `console.log/info/warn/error`。该约定由模块导入方式体现（`main.ts` 及各组件均以 `import { logger } from "./utils/logger.ts"` 获取）。
- **来源标识**：日志正文以方括号包裹来源模块名作为前缀（如 `[Main]`、`[DataCleaner]`），便于在大量输出中快速定位。
- **用户/AI 对话日志**：交互类日志应使用 `logger.userInput` 和 `logger.aiResponse`，分别以蓝色和绿色高亮用户名，保持会话日志的可读性。
- **长文本处理**：当需要把可能包含换行或超长内容的文本放入飞书消息/卡片时，必须先经 `formatLogText(text, maxLength?)` 清洗，默认最大长度 100 字符，超出会截断并追加 `...`。
- **无运行时级别切换**：不支持通过环境变量或 API 动态调整日志级别；如需减少输出，需修改源码中的日志调用点。
- **无持久化**：日志不写入磁盘文件，也不发送到外部采集服务；进程重启后日志丢失。
- **测试覆盖范围**：目前仅有 `formatLogText` 的单元测试，`logger` 本身未被单独测试。

## 5. 总结

这是一个面向本地开发/轻量部署场景的极简日志子系统：零依赖、纯 stdout 输出、ANSI 彩色时间戳 + 来源标签 + 语义化方法（info/warn/error/userInput/aiResponse）。它适合调试和运维观察，但不具备结构化输出、分级过滤、远端投递等生产级特性。若未来需要增强，可在现有 `logger` 之上增加级别过滤、JSON 模式输出或 sink 抽象。