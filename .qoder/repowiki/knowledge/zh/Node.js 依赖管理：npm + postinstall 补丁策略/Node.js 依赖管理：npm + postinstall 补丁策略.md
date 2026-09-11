---
kind: dependency_management
name: Node.js 依赖管理：npm + postinstall 补丁策略
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - scripts/patch-pi-ai.js
    - scripts/start.js
    - .env.example
---

## 1. 使用的系统/方法
- 包管理器：npm（通过 `package.json` 声明依赖，`package-lock.json` 锁定版本）。
- 运行时：TypeScript 源码通过 `tsx` 直接运行，无编译产物；测试使用 `vitest`。
- 补丁机制：在 `postinstall` 钩子中执行 `scripts/patch-pi-ai.js`，对 `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js` 进行文本替换，删除包含 `anthropic-dangerous-direct-browser-access` 的请求头以绕过中转站 403。

## 2. 关键文件
- `package.json`：声明所有生产与开发依赖、脚本命令以及 `postinstall` 钩子。
- `package-lock.json`：npm 生成的锁文件，用于保证依赖树可重现。
- `scripts/patch-pi-ai.js`：安装后自动修补第三方库的脚本。
- `scripts/start.js`：进程启动包装器，负责优雅退出（SIGTERM/SIGKILL），与依赖管理间接相关（确保依赖加载后的进程生命周期可控）。
- `.env.example`：环境变量模板，配合 `dotenv` 注入配置。

## 3. 架构与约定
- 依赖分层清晰：
  - 生产依赖：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`（飞书 Pi Agent SDK 套件）、`@larksuiteoapi/node-sdk`（飞书官方 SDK）、`express`、`body-parser`、`croner`、`dotenv`。
  - 开发依赖：`typescript`、`tsx`、`vitest`、`vite`、`@types/*`。
- 版本策略：核心 SDK 套件使用 `^0.84.2` 语义化版本范围，允许小版本升级；`@larksuiteoapi/node-sdk` 固定到 `1.73.0`，表明该依赖需要严格锁定以避免兼容问题。
- 模块格式：项目声明 `"type": "module"`，全部使用 ESM 语法（`import/export`），包括补丁脚本和启动脚本。
- 补丁优先于 fork：未对 `pi-ai` 进行本地 fork 或 patch 文件持久化，而是选择在每次 `npm install` 时动态修改 `node_modules` 中的文件。脚本对缺失目标文件的情况仅输出警告而不阻塞安装，具备容错性。

## 4. 约定与约束
- **禁止直接提交 `node_modules`**：`.gitignore` 会忽略 `node_modules`，依赖必须通过 `npm install` 从 npm registry 恢复。
- **安装后必须打补丁**：`postinstall` 是强制流程，任何新环境首次安装都会自动执行补丁；若目标文件不存在（例如上游路径变更），脚本仅告警不中断安装，因此升级上游包时需同步更新补丁逻辑。
- **SDK 套件版本联动**：三个 `@earendil-works/*` 包均使用相同主版本 `^0.84.2`，暗示它们需保持版本对齐，避免内部 API 不一致。
- **环境变量驱动**：通过 `dotenv` 加载 `.env`，配置文件由 `src/config.ts` 读取，运行时配置与代码解耦。
- **无私有仓库/镜像配置**：当前仓库未发现 `.npmrc`、`pnpm-workspace.yaml`、`yarn.lock` 等私有源配置，默认从公共 npm registry 拉取依赖。
- **类型安全**：通过 `tsc --noEmit` 在 `check` 脚本中进行类型检查，确保依赖的 TypeScript 类型可用。