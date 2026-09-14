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
---

## 1. 使用的系统与工具

本项目为 TypeScript/Node.js 项目，依赖管理基于 **npm**（由 `package.json` 与 `package-lock.json` 共同体现）。
- 包清单定义在根目录 `package.json`，锁定版本在 `package-lock.json`。
- 运行时通过 `tsx`（ESM 直跑）执行源码，无构建产物；测试使用 `vitest`。
- 项目标记为 `"private": true`，不发布到 npm registry。

## 2. 关键文件

- `package.json`：声明所有运行时依赖与开发依赖，并定义 `postinstall` 钩子。
- `scripts/patch-pi-ai.js`：`postinstall` 执行的补丁脚本。
- `scripts/start.js`：进程启动包装器（负责优雅退出），非依赖管理核心但参与安装后流程。
- `node_modules/`：npm 安装的第三方包目录（未提交到版本控制，仅本地存在）。

## 3. 架构与约定

### 3.1 依赖分组
- **运行时依赖**：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`（飞书 Pi Agent 生态）、`@larksuiteoapi/node-sdk`（飞书 OpenAPI SDK）、`express`、`body-parser`、`croner`、`dotenv`。
- **开发依赖**：`typescript`、`tsx`、`vitest`、`vite`、`@types/*` 类型声明。

### 3.2 版本约束策略
- 对核心三方库使用 `^` 语义化版本范围（如 `^0.84.2`、`^5.2.1`），允许小版本升级。
- 对 `@types/node`、`tsx`、`typescript` 等工具链使用精确版本号（如 `22.19.19`、`4.22.1`、`5.9.3`），保证构建可重复。
- 通过 `package-lock.json` 锁定实际解析出的树形依赖图，确保不同环境一致。

### 3.3 postinstall 补丁机制
项目通过 `package.json.scripts.postinstall` 自动执行 `node scripts/patch-pi-ai.js`，在每次 `npm install` 后修补 `@earendil-works/pi-ai` 的 `dist/api/anthropic-messages.js`，删除导致中转站返回 403 的请求头 `anthropic-dangerous-direct-browser-access: "true"`。
- 该补丁是**幂等的**：若目标文件中不存在该请求头，则不做修改。
- 该补丁是**容错的**：若目标文件路径变更或不存在，仅输出警告而不阻塞安装流程。
- 这体现了“对不受控的第三方包进行热修复”的约定——不在上游 PR 等待期间阻塞部署。

### 3.4 私有包来源
`@earendil-works/*` 系列包属于内部/私有组织包，需依赖 npm registry 上的组织作用域权限。当前仓库未包含 `.npmrc` 或 `package.json` 中的 `registry` 配置，说明默认使用 npm 官方 registry 或通过环境变量/全局 `.npmrc` 配置认证。

## 4. 约定与约束

- **禁止手动编辑 `node_modules`**：所有修改必须通过 `postinstall` 脚本完成，否则下次 `npm install` 会被覆盖。
- **升级核心依赖时需同步检查补丁脚本**：`patch-pi-ai.js` 硬编码了目标文件路径 `../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`，若上游包结构变化，需要更新该路径。
- **依赖升级应保留 `package-lock.json` 同步提交**：由于使用了 `^` 范围，锁文件是保证可重现安装的关键。
- **开发环境与生产环境共享同一份依赖**：没有区分 `--production` 安装，因为项目是私有的单进程服务，且 `tsx` 作为运行时直接执行源码。
- **无 vendoring / nohoist / workspace 多包管理**：项目是单一 npm package，未使用 pnpm/yarn workspaces 或 monorepo 结构。
- **无私有 registry 显式配置**：依赖解析依赖 npm 默认行为或外部 `.npmrc`，未在仓库内固化。

## 5. 风险点

- 补丁脚本依赖固定路径，一旦 `@earendil-works/pi-ai` 重构 dist 目录结构，`npm install` 将静默跳过补丁但仍可能运行异常。
- 使用 `^` 范围可能导致 CI 拉取到比预期更新的次版本，尽管有 lockfile 保护，仍需关注 `@earendil-works/*` 包的破坏性更新。
- 未使用 `npm ci` 强制从 lockfile 安装（CI 中应优先使用 `npm ci` 而非 `npm install` 以保证一致性）。