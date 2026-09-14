---
kind: build_system
name: 基于 tsx + Vitest 的纯 TypeScript 运行时构建体系
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - tsconfig.json
    - vitest.config.ts
    - scripts/start.js
    - scripts/patch-pi-ai.js
    - .env.example
---

## 1. 使用的系统与工具

本项目是一个 Node.js 运行时（Agent 服务），采用**无编译产物、直接运行 TypeScript** 的轻量构建方式：
- **运行时入口**：通过 `tsx`（ESM 模式的 TypeScript 执行器）直接执行 `src/main.ts`，不生成 JS 中间产物。
- **类型检查**：`tsc --noEmit` 仅做类型校验，配合 `tsconfig.json` 中 `"noEmit": true` 确保不会输出任何 `.js` 文件。
- **测试框架**：使用 `vitest`（v3.2.4）+ `vite` 作为测试与模块解析引擎，测试用例统一放在 `test/` 目录，匹配模式为 `test/**/*.test.ts`。
- **包管理**：`package.json` 声明依赖，`package-lock.json` 锁定版本；项目标记为 `private`，不发布到 npm。
- **环境变量**：通过 `dotenv` 加载 `.env`，并提供 `.env.example` 作为模板。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `package.json` | 定义脚本命令、依赖、`postinstall` 钩子 |
| `tsconfig.json` | TypeScript 配置（ES2022 target、NodeNext module、strict 模式） |
| `vitest.config.ts` | Vitest 测试包含规则 |
| `scripts/start.js` | 进程守护启动器，处理 SIGTERM/SIGINT 优雅退出 |
| `scripts/patch-pi-ai.js` | `postinstall` 自动修补第三方依赖以适配部署环境 |
| `.env.example` | 环境变量模板 |

## 3. 架构与约定

### 3.1 开发 / 构建脚本约定
- `npm start` → `tsx src/main.ts`：生产/本地直接运行。
- `npm run dev` → `tsx watch src/main.ts`：热重载开发。
- `npm run config` → `tsx src/config-server.ts`：启动配置页面服务。
- `npm run check` → `tsc --noEmit -p tsconfig.json`：仅做类型检查，不参与打包。
- `npm test` → `vitest --run --config vitest.config.ts`：运行全部单元测试。

### 3.2 依赖修补机制（postinstall 钩子）
安装依赖后自动执行 `scripts/patch-pi-ai.js`，对 `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js` 进行文本替换，删除导致中转站 403 的请求头 `anthropic-dangerous-direct-browser-access`。该脚本具备容错：若目标文件不存在或无需修改，仅告警不阻塞安装。

### 3.3 进程管理与优雅退出
`scripts/start.js` 通过 `child_process.spawn` 拉起 `tsx src/main.ts`，并监听 `SIGINT`/`SIGTERM`：先发送 `SIGTERM` 给子进程，等待最多 5 秒，超时则强制 `SIGKILL`，最后自身退出。Windows 下额外通过 `readline` 监听 Ctrl+C。这是容器化或 systemd 等外部进程管理器期望的优雅关闭行为。

### 3.4 类型与模块约定
- `tsconfig.json` 启用 `"type": "module"`（在 package.json 中声明），所有源码使用 ESM import/export。
- `target: ES2022`、`module: NodeNext`、`moduleResolution: NodeNext`，与 Node.js 原生 ESM 兼容。
- `strict: true`、`erasableSyntaxOnly: true`、`skipLibCheck: true`，强调类型安全但跳过第三方库类型检查。
- 允许 `allowImportingTsExtensions: true`，可在 import 时省略 `.ts` 后缀。

## 4. 约束与规则

- **不产出构建产物**：`tsconfig.json` 中 `"noEmit": true` 是硬性约束，项目不生成任何 `.js` 文件，运行期由 `tsx` 即时编译。
- **测试必须位于 `test/` 且以 `.test.ts` 结尾**：`vitest.config.ts` 的 include 规则限定此路径与命名约定。
- **依赖升级需重新应用补丁**：每次 `npm install` 都会触发 `postinstall` 修补 `pi-ai`，因此升级 `@earendil-works/pi-ai` 后仍需保证补丁脚本可定位到新路径。
- **环境变量必须通过 `.env` 提供**：项目通过 `dotenv` 加载，`.env.example` 定义了必需变量结构，部署时需复制并填写。
- **进程必须响应 SIGTERM**：`scripts/start.js` 实现了标准信号处理，要求被管进程（`src/main.ts`）也正确处理关闭逻辑以实现优雅退出。
- **无 Dockerfile / CI 流水线**：仓库未包含 Docker 构建、CI 配置文件，构建与部署流程不在本仓库内定义，推测由外部平台（如飞书内部部署系统）驱动。
- **版本号策略**：`package.json` 中 `version: "0.1.0"` 且 `private: true`，表明这是一个内部私有包，版本仅用于标识，不对外发布。