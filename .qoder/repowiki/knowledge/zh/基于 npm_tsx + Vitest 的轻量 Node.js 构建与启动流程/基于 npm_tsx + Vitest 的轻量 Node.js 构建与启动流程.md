---
kind: build_system
name: 基于 npm/tsx + Vitest 的轻量 Node.js 构建与启动流程
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - tsconfig.json
    - vitest.config.ts
    - scripts/patch-pi-ai.js
    - scripts/start.js
---

## 1. 使用的系统与工具

该项目是一个纯 TypeScript 的 Node.js 服务，没有 Makefile、Dockerfile、CI 流水线或发布脚本。构建与运行完全依赖 npm 生态：

- **语言与运行时**：TypeScript 5.9.3，ES2022 target，`type: "module"`（ESM），通过 `tsconfig.json` 配置编译选项。
- **执行方式**：不预编译产物，直接通过 `tsx`（4.22.1）在运行时将 TS 转译为 JS 并执行入口 `src/main.ts`。
- **测试框架**：Vitest 3.2.4，配置文件 `vitest.config.ts`，测试文件约定为 `test/**/*.test.ts`。
- **包管理**：npm（`package-lock.json` 存在），版本由 `package.json` 中的 `version: "0.1.0"` 管理。
- **补丁机制**：通过 `postinstall` 钩子执行 `scripts/patch-pi-ai.js`，在安装依赖后自动修补第三方依赖 `@earendil-works/pi-ai` 中导致 403 的请求头。

## 2. 关键文件

- `package.json`：定义项目元信息、脚本命令、依赖与 devDependencies。
- `tsconfig.json`：TS 编译配置，启用严格模式、NodeNext 模块解析、`noEmit`（仅类型检查）。
- `vitest.config.ts`：Vitest 测试包含规则。
- `scripts/patch-pi-ai.js`：安装后自动修补第三方依赖的脚本。
- `scripts/start.js`：进程守护式启动脚本，负责优雅退出（SIGTERM/SIGINT → 先 SIGTERM 等待 5s → 再 SIGKILL）。

## 3. 架构与约定

### 脚本约定（npm scripts）
| 脚本 | 作用 |
|---|---|
| `npm start` | 通过 `tsx src/main.ts` 启动主服务 |
| `npm run dev` | 通过 `tsx watch` 监听文件变化热重载 |
| `npm run config` | 启动本地配置页面服务 `src/config-server.ts` |
| `npm run check` | 执行 `tsc --noEmit` 进行类型检查 |
| `npm test` | 运行 Vitest 单元测试 |
| `postinstall` | 自动修补 `@earendil-works/pi-ai` 的 anthropic 请求头 |

### 无构建产物策略
`tsconfig.json` 设置 `"noEmit": true`，意味着项目不生成 `.js` 输出文件，所有代码以源码形式通过 `tsx` 直接执行。这简化了部署但要求运行环境必须安装 `tsx`。

### 进程生命周期管理
`scripts/start.js` 作为独立入口，使用 `child_process.spawn` 拉起 `npx tsx src/main.ts`，并实现跨平台（含 Windows）的信号处理：收到 SIGINT/SIGTERM 后向子进程发送 SIGTERM，等待最多 5 秒，超时则强制 SIGKILL，确保容器或服务管理器能可靠终止进程。

### 第三方依赖修补
`postinstall` 钩子在每次 `npm install` 后运行 `scripts/patch-pi-ai.js`，该脚本读取 `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`，删除其中 `anthropic-dangerous-direct-browser-access: true` 请求头，从而避免调用 Anthropic API 时出现 403。修补失败（如路径变更）仅告警不阻塞安装。

## 4. 约束与规范

- **开发/生产统一执行模型**：开发与生产均通过 `tsx` 直接运行 TS 源码，不存在独立的 build step，因此 `npm run check` 是唯一的静态检查入口。
- **测试文件命名与位置**：所有测试文件必须位于 `test/` 目录下且后缀为 `.test.ts`，由 `vitest.config.ts` 的 `include` 规则强制。
- **模块系统**：项目强制 ESM（`"type": "module"`），TS 使用 `NodeNext` 模块解析，禁止 CommonJS 混用。
- **类型严格性**：`strict: true` + `erasableSyntaxOnly: true`，要求所有类型声明可擦除，不允许遗留 JS 兼容语法。
- **环境变量**：通过 `dotenv` 加载 `.env`（见 `.env.example`），未提供 CI/环境变量注入说明。
- **无外部构建/发布管线**：仓库中未发现 Dockerfile、Makefile、GitHub Actions、`.github/workflows`、`build.sh`、`publish` 脚本等，因此不存在自动化构建、镜像打包或发布到 npm registry 的流程。

## 5. 总结

这是一个极简的 Node.js 服务构建体系：以 `package.json` 为中心，通过 `tsx` 零构建运行 TypeScript，用 `vitest` 跑测试，用 `postinstall` 修补上游依赖。部署时只需 `npm install && npm start`（或 `node scripts/start.js`）。由于缺少 Dockerfile、CI、发布脚本等，该项目的“构建系统”停留在本地开发阶段，尚未形成完整的制品化与发布流水线。