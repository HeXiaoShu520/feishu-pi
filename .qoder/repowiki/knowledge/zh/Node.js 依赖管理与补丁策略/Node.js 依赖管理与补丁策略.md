---
kind: dependency_management
name: Node.js 依赖管理与补丁策略
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - scripts/patch-pi-ai.js
    - .env.example
---

## 1. 使用的系统与工具

本项目采用 **npm + Node.js** 生态进行依赖管理，核心文件为根目录的 `package.json` 与 `package-lock.json`。项目类型为 ES Module（`"type": "module"`），通过 `tsx` 直接运行 TypeScript 源码，无需预先编译。

- **包管理器**：npm（由 `package-lock.json` 锁定版本）
- **运行时/开发工具链**：`tsx`（TypeScript 执行器）、`typescript`、`vitest`（测试）、`vite`（构建/配置页面）
- **私有/内部包来源**：`@earendil-works/*` 命名空间下的多个包（`pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-telemetry`），表明存在企业内 npm 私有仓库或组织级发布源

## 2. 关键文件

- `package.json`：声明所有运行时与开发依赖，定义脚本命令
- `package-lock.json`：精确锁定所有依赖树版本，保证安装可重现
- `scripts/patch-pi-ai.js`：在 `npm install` 后自动修补第三方库的缺陷
- `.env.example`：环境变量模板（依赖项如 Lark SDK 凭据等通过环境变量注入）

## 3. 架构与约定

### 依赖分层
- **运行时依赖**：`@larksuiteoapi/node-sdk`（飞书 OpenAPI）、`express`、`body-parser`、`dotenv`、`croner`，以及 `@earendil-works/*` 系列 Pi Agent 相关包
- **开发依赖**：`tsx`、`typescript`、`vitest`、`vite`、类型声明包（`@types/*`）

### 启动与补丁流程
项目通过 npm scripts 组织生命周期：
- `start`：`tsx src/main.ts` 直接启动
- `dev`：`tsx watch src/main.ts` 热重载开发
- `postinstall`：**关键机制** — 每次 `npm install` 后自动执行 `node scripts/patch-pi-ai.js`

### 补丁策略（vendoring 替代方案）
项目未使用 `vendor/` 或 `patches/` 目录对第三方代码做静态修改，而是采用 **运行时 postinstall 补丁** 的方式：`patch-pi-ai.js` 在安装后动态读取 `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`，删除其中导致中转站 403 的 `anthropic-dangerous-direct-browser-access` 请求头字段。该脚本容错处理目标文件不存在的情况（仅告警不阻塞安装），因此升级 `pi-ai` 包路径变化时不会破坏安装流程。

### 版本管理
- 生产依赖使用语义化版本范围（`^` 前缀），允许小版本/补丁更新
- `@larksuiteoapi/node-sdk` 固定到精确版本 `1.73.0`，体现对飞书 SDK 版本的强约束
- `package-lock.json` 锁定完整依赖树，确保 CI/本地安装一致性

### 私有注册表
当前仓库中未发现 `.npmrc`、`package.json` 中的 `registry` 字段或 `NPM_CONFIG_REGISTRY` 环境变量声明。`@earendil-works/*` 包的解析应通过全局 npm 配置或 CI 环境中的私有 registry 完成，不在仓库内显式声明。

## 4. 约定与约束

- **禁止手动编辑 `node_modules`**：所有第三方修改必须通过 `postinstall` 脚本（如 `patch-pi-ai.js`）实现，避免被下一次 `npm install` 覆盖
- **补丁脚本需幂等且健壮**：`patch-pi-ai.js` 在目标文件缺失时仅 `console.warn` 并继续，保证 `npm install` 永不失败
- **依赖变更需同步更新 `package-lock.json`**：通过 `npm install` 而非手工修改锁文件来维护依赖树
- **环境变量驱动外部依赖**：SDK 凭据、LLM 端点等敏感配置通过 `.env` 注入，不写入代码或配置文件
- **内部包统一以 `@earendil-works` 命名空间发布**：便于在企业私有 npm 仓库中集中管理