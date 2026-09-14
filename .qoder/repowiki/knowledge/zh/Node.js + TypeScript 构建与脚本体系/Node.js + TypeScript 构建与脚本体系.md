---
kind: build_system
name: Node.js + TypeScript 构建与脚本体系
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

本项目是一个纯 Node.js ESM + TypeScript 应用，构建与运行完全基于 npm scripts、TypeScript 编译器（tsc）和 tsx 运行时，未引入 Webpack/Vite 打包器，也未使用 Makefile/Dockerfile/CI 流水线。

- **语言与模块系统**：`package.json` 中声明 `"type": "module"`，TS 配置 `tsconfig.json` 将 `module` 与 `moduleResolution` 均设为 `NodeNext`，目标为 `ES2022`，因此源码以原生 ESM 形式直接由 tsx 执行，不产出独立 JS 产物（`noEmit: true`）。
- **开发/启动**：通过 `tsx` 直接运行 `.ts` 入口；生产环境可通过 `scripts/start.js` 作为进程守护脚本启动。
- **类型检查**：`npm run check` 调用 `tsc --noEmit -p tsconfig.json` 进行静态检查。
- **测试**：基于 Vitest 3.x，配置文件 `vitest.config.ts`，测试文件约定位于 `test/**/*.test.ts`，通过 `npm test`（即 `vitest --run`）执行。
- **依赖锁定**：使用 `package-lock.json` 锁定依赖版本。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `package.json` | 项目元信息、脚本命令、依赖声明、`postinstall` 钩子 |
| `tsconfig.json` | TypeScript 编译选项（ES2022 / NodeNext / strict / noEmit） |
| `vitest.config.ts` | Vitest 测试包含路径配置 |
| `scripts/patch-pi-ai.js` | `postinstall` 自动修补第三方依赖的补丁脚本 |
| `scripts/start.js` | 进程守护式启动脚本，处理 SIGTERM/SIGINT 优雅退出 |
| `src/main.ts` | 应用主入口（由 `tsx src/main.ts` 直接运行） |
| `src/config-server.ts` | 本地配置服务入口（`npm run config`） |

## 3. 架构与约定

### 3.1 无构建产物模式
项目采用“零构建”策略：`noEmit: true` 意味着 tsc 仅做类型检查，不生成任何 `.js` 输出。运行期由 `tsx` 在内存中加载并执行 TS 源码。这种模式简化了部署——只需安装依赖并在支持 ES2022 + ESM 的 Node.js 环境中直接运行入口。

### 3.2 脚本命令约定
`package.json.scripts` 定义了统一入口：
- `npm start` → `tsx src/main.ts`（应用启动）
- `npm run dev` → `tsx watch src/main.ts`（热重载开发）
- `npm run config` → `tsx src/config-server.ts`（本地配置页服务）
- `npm run check` → `tsc --noEmit`（类型检查）
- `npm test` → `vitest --run`（单元测试）

### 3.3 postinstall 补丁机制
`package.json` 中声明 `"postinstall": "node scripts/patch-pi-ai.js"`，在 `npm install` 后自动执行。该脚本会修改 `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`，删除导致中转站 403 的 `anthropic-dangerous-direct-browser-access` 请求头。补丁逻辑对缺失目标文件的情况仅告警不阻塞安装，保证升级兼容性与安装鲁棒性。

### 3.4 进程管理约定
`scripts/start.js` 通过 `child_process.spawn` 启动 `tsx src/main.ts`，并监听 `SIGTERM`/`SIGINT` 信号：先向子进程发送 `SIGTERM`，等待最多 5 秒，若未退出则强制 `SIGKILL`，最后自身退出。Windows 平台额外通过 `readline` 处理 Ctrl+C。该脚本用于容器或 PM2 等进程管理器中确保优雅关停。

### 3.5 测试组织约定
- 测试框架：Vitest 3.x
- 测试文件命名：`*.test.ts`
- 测试目录：`test/`（含 `unit/` 子目录与根级单测文件）
- 配置：`vitest.config.ts` 中 `include: ["test/**/*.test.ts"]`
- 运行：`npm test` 等价于 `vitest --run --config vitest.config.ts`

## 4. 约束与规则

- **禁止 emit 产物**：`tsconfig.json` 显式设置 `noEmit: true`，项目不生成任何编译产物，所有运行均由 tsx 直接执行 TS 源码。
- **ESM 强制**：`package.json` 的 `"type": "module"` 使整个包默认按 ESM 解析，`.ts` 文件需遵循 ESM import/export 语法。
- **严格类型检查**：`strict: true` 开启全部严格模式选项，配合 `forceConsistentCasingInFileNames` 要求文件名大小写一致。
- **依赖版本锁定**：通过 `package-lock.json` 锁定依赖树，避免不同环境间行为差异。
- **第三方补丁不可中断安装**：`postinstall` 中的补丁脚本捕获异常并仅 `console.warn`，确保即使补丁失败也不阻断 `npm install`。
- **测试文件位置与命名固定**：Vitest 配置限定 `test/**/*.test.ts`，新增测试必须遵循此路径与命名约定才能被自动发现。

## 5. 缺失项说明

仓库中未发现以下构建相关资产：
- 无 `Dockerfile` / `docker-compose.yml` / `Dockerfile.*` 等容器化定义
- 无 GitHub Actions / GitLab CI / Jenkinsfile 等 CI 流水线配置
- 无 Makefile / build.sh / release.sh 等构建脚本
- 无发布流程（无 `npm publish` 脚本、无 changelog/release 工具）
- 无跨平台交叉编译配置

这意味着本项目的“构建系统”本质上就是 npm scripts + tsx + tsc + vitest 的组合，部署方式由外部编排（如容器镜像、PM2、服务器直接 `npm start`）负责，不在本仓库内定义。