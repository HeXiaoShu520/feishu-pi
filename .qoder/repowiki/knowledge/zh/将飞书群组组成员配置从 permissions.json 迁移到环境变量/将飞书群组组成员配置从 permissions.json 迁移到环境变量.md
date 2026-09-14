---
kind: design
name: 将飞书群组组成员配置从 permissions.json 迁移到环境变量
source: session
category: adr
---

# 将飞书群组组成员配置从 permissions.json 迁移到环境变量

_来源：a57d3a5 → 56f94b3 提交周期内记录的编码计划——内容为规划时意图，实现可能滞后或有出入。_

**状态：** accepted

## 背景
群组成员列表（如 owner、user1 等组的 members）原本硬编码在 `.agent/permissions.json` 中，导致每次调整成员都需要修改并重新提交代码。为支持运行时灵活配置且避免代码变更，需将组成员配置外置。

## 决策驱动
- 运行时可配置性
- 避免代码提交变更
- 与现有 FEISHU_ADMIN 机制保持一致

## 备选方案
- **保留在 permissions.json 中** _（已否决）_ — 优点：集中管理权限定义；缺点：修改成员需改代码并提交；无法动态调整
- **通过 config-server 的 MANAGED_KEYS 白名单管理** _（已否决）_ — 优点：可通过 UI 编辑；缺点：需要新增白名单键；当前计划明确不纳入 MANAGED_KEYS，建议用户手动维护 .env
- **使用 FEISHU_GROUP_<NAME>=成员1,成员2,... 环境变量** — 优点：无需改动 config-server；解析逻辑简单；与 FEISHU_ADMIN 风格一致；非 MANAGED_KEYS 的键在 stringifyEnv 中原样保留；缺点：需在部署时设置环境变量；格式约定需文档化

## 决策
在 `src/config.ts` 的 `loadConfig()` 中解析所有以 `FEISHU_GROUP_` 开头的环境变量，将其映射为 `groupMembership: Record<string, string[]>` 传入 `PermissionPolicy`；`GroupFields` 接口移除 `members` 字段，`groupsFor()` 改为从注入的 `groupMembership` 查找组成员；`.agent/permissions.json` 中的 members 被移除，测试同步更新。

## 影响
组成员配置现在完全由环境变量驱动，可在不重新部署代码的情况下调整；config-server 不主动管理这些键，但非 MANAGED_KEYS 的环境变量在序列化时会原样保留，便于后续扩展；owner 组仍同时支持 adminId 匹配和 FEISHU_GROUP_OWNER 匹配两条路径。