---
kind: external_dependency
name: Pi Agent 运行时（@earendil-works/pi-ai）
slug: pi-ai
category: external_dependency
category_hints:
    - framework_behavior
    - sdk_real_api
scope:
    - '**'
source_files:
    - scripts/patch-pi-ai.js
    - src/runtime/feishu-pi-runtime.ts
    - package.json
---

### Pi 运行时
- 角色：Agent loop、模型流式调用、Session/Provider 适配、内置工具（read/write/edit/bash）的底座，被 feishu-pi 通过公开 SDK 组合复用。
- 集成点：`src/runtime/feishu-pi-runtime.ts` 使用 `@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai` 创建 `AgentSession`；`getModel` 通过 `pi-ai/compat` 按 provider/name/baseUrl 解析模型，支持 API 中转站。
- 依赖补丁：`postinstall` 执行 `scripts/patch-pi-ai.js`，删除 `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js` 中的 `anthropic-dangerous-direct-browser-access` 请求头，避免经 API 中转站调用时返回 403；升级后自动重放。
- 版本策略：`@earendil-works/*` 跟随上游 minor 版本升级。
- 注意：本项目不 fork 也不修改 Pi 核心代码，仅维护飞书连接、会话路由、回复生命周期、权限边界与业务 Function Calling。