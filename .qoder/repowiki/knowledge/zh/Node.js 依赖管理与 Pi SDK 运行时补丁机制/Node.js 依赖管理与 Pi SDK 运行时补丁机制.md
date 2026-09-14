---
kind: dependency_management
name: Node.js 依赖管理与 Pi SDK 运行时补丁机制
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - scripts/patch-pi-ai.js
    - docs/pi-sdk-patch.md
---

## 1. 使用的系统/方法

本项目采用 **npm + Node.js** 作为包管理方案，使用 `package.json` 声明依赖、`package-lock.json` 锁定版本。运行时代码为 TypeScript（通过 `tsx` 直接执行），构建工具链包含 `typescript`、`vitest`、`vite`。

项目未使用 yarn/pnpm、未启用私有 npm registry、未使用 `vendor/` 目录进行源码级 vendoring，而是依赖标准的 `node_modules` 安装流程。

## 2. 关键文件与包

- **`package.json`**：定义项目元数据、脚本命令、生产依赖与开发依赖。
- **`package-lock.json`**：npm 生成的精确依赖树锁文件，用于保证跨环境一致安装。
- **`scripts/patch-pi-ai.js`**：自定义 postinstall 补丁脚本，在每次 `npm install` 后自动修改第三方库行为。
- **`docs/pi-sdk-patch.md`**：对补丁机制的完整说明文档。
- **`.env.example`**：环境变量模板，用于配置模型提供商（Anthropic / OpenAI）等运行时依赖。

核心第三方依赖包括：
- `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`（Pi SDK 生态，版本 ^0.84.2）
- `@larksuiteoapi/node-sdk`（飞书官方 SDK，固定版本 1.73.0）
- `express`、`body-parser`、`croner`、`dotenv` 等运行时库

## 3. 架构与约定

### 依赖版本策略
- 生产依赖普遍使用 `^` 语义化版本范围（如 `^0.84.2`、`^5.2.1`），允许小版本升级。
- 部分关键依赖使用固定版本（如 `@types/node: 22.19.19`、`tsx: 4.22.1`、`@larksuiteoapi/node-sdk: 1.73.0`），以规避类型或 API 不兼容风险。
- 所有依赖由 `package-lock.json` 锁定，确保 CI/部署环境与本地一致。

### 运行时补丁机制（核心设计）
项目通过 `postinstall` 钩子集成自定义补丁脚本，解决 Pi SDK 与第三方 Anthropic 中转站之间的兼容性问题：

1. `npm install` 完成后自动执行 `node scripts/patch-pi-ai.js`。
2. 脚本读取 `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`。
3. 使用正则 `/"anthropic-dangerous-direct-browser-access":\s*"true",?\s*/g` 删除该请求头。
4. 若目标文件不存在（例如 SDK 升级导致路径变更），仅输出警告而不中断安装流程。

该机制的设计决策在 `docs/pi-sdk-patch.md` 中明确记录：**不使用 patch-package**，因为后者会绑定特定版本号，升级后需重新生成补丁；而自定义脚本通过正则匹配适配任意版本，维护成本更低。

### 多模型提供商切换
通过 `.env` 环境变量切换底层 AI 提供商（Anthropic 或 OpenAI），OpenAI 实现无需补丁即可直接使用，为不想维护补丁的用户提供可选路径。

## 4. 约定与约束

- **依赖声明位置**：所有第三方依赖必须声明在 `package.json` 的 `dependencies` 或 `devDependencies` 中，禁止隐式依赖。
- **版本锁定**：提交 `package-lock.json`，禁止手动编辑，以保证可重复安装。
- **补丁不可逆**：`scripts/patch-pi-ai.js` 是项目内唯一对 `node_modules` 的写操作入口，任何对第三方包的修改都应通过类似脚本而非直接编辑 `node_modules`。
- **补丁健壮性**：补丁脚本必须容忍目标文件缺失或格式变化（try/catch + 非阻塞），避免破坏 `npm install` 的成功退出码。
- **文档同步**：补丁逻辑变更需同步更新 `docs/pi-sdk-patch.md`，保持文档与实现一致。
- **私有仓库/代理**：当前仓库未配置私有 npm registry 或镜像源，依赖均从公共 npm registry 拉取。
- **无 vendoring**：项目未将第三方源码纳入版本控制，完全依赖 npm 的 `node_modules` 机制。

## 5. 约束来源

- `package.json` 中的 `postinstall` 字段强制在安装后执行补丁脚本。
- `docs/pi-sdk-patch.md` 明确记录了“为什么不用 patch-package”以及补丁的适用场景和故障排查步骤，构成团队约定的文档化依据。
- `package-lock.json` 的存在表明版本一致性是硬性要求（由 npm 保证）。