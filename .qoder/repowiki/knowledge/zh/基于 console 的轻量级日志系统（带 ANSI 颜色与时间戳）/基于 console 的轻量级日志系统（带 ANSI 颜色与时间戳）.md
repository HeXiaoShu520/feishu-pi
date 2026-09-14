---
kind: logging_system
name: 基于 console 的轻量级日志系统（带 ANSI 颜色与时间戳）
category: logging_system
scope:
    - '**'
source_files:
    - src/utils/logger.ts
    - src/feishu/log-utils.ts
    - test/unit/log-utils.test.ts
---

## 1. 使用的系统/方案

本项目没有引入第三方日志框架（如 winston、pino、bunyan、debug 等），而是实现了一个极简的内置日志模块 `src/utils/logger.ts`，直接封装 Node.js 的 `console.info / console.warn / console.error / console.log`，为其统一添加：
- 固定格式的时间前缀 `[YYYY-MM-DD HH:MM:SS]`
- ANSI 彩色标记（通过 `colors` 对象提供 gray/yellow/red/cyan/green/blue/magenta/bright/reset）
- 语义化方法：`info`、`warn`、`error`、`log`、`userInput`、`aiResponse`

此外，`src/feishu/log-utils.ts` 提供了一个纯函数 `formatLogText(text, maxLength)`，用于在写入日志前去除换行符、截断过长文本并追加 `...`，避免多行或超长消息破坏终端输出。

## 2. 关键文件

- `src/utils/logger.ts` — 日志门面，导出 `logger` 对象和 `colors` 常量
- `src/feishu/log-utils.ts` — 日志文本格式化辅助函数
- `test/unit/log-utils.test.ts` — 对 `formatLogText` 的行为进行单元测试
- 各业务模块通过 `import { logger } from "../utils/logger.ts"` 使用日志（覆盖 `feishu/*`、`guard/*`、`runtime/*`、`tools/*`、`config-server.ts`、`main.ts` 等）

## 3. 架构与约定

- **单点入口**：所有日志输出均经过 `src/utils/logger.ts`，不直接使用裸 `console.*` 打印业务日志（除 `main.ts` 中启动提示等少量场景）。
- **无结构化字段**：日志以字符串拼接形式输出，不包含 JSON 结构化的字段（如 level、timestamp、module、traceId 等）。时间戳由 logger 内部生成，而非调用方传入。
- **无日志级别过滤**：未实现按级别开关（如 DEBUG/INFO/WARN/ERROR）的能力，所有级别的方法都会输出到对应 stdout/stderr。
- **无 sink/文件输出**：日志仅输出到控制台，没有配置文件路径、滚动策略、异步写入等机制。
- **用户/AI 对话专用通道**：`userInput` 用蓝色高亮用户名，`aiResponse` 用绿色高亮，便于在终端区分人类输入与 AI 回复。
- **文本清洗约定**：需要写入日志的富文本/多行内容应先经 `formatLogText` 处理，确保单行且不超过默认 100 字符。

## 4. 约定与约束

- **统一导入路径**：业务代码统一从 `../utils/logger.ts`（相对 feishu/runtime/guard/tools 目录）或 `./utils/logger.ts`（相对 src 根目录）导入，保持风格一致。
- **颜色不可自定义**：颜色由模块内 `colors` 常量定义，调用方不应自行拼接 ANSI 码；新增日志类型应复用现有颜色语义（gray=时间、yellow=warn、red=error、blue=user、green=AI）。
- **日志内容长度限制**：通过 `formatLogText` 强制将多行合并为单行并截断至默认 100 字符，防止日志刷屏。
- **测试覆盖范围**：目前仅有 `formatLogText` 的单元测试，logger 本身因直接依赖 `console` 未被单独测试。
- **适用范围**：该日志系统适用于当前 CLI/本地调试场景；若未来需要结构化日志、远程收集或多环境级别控制，需替换为正式日志框架。