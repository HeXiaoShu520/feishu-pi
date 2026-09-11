---
kind: external_dependency
name: 飞书开放平台 Node SDK 及 lark-cli 辅助
slug: lark-node-sdk
category: external_dependency
category_hints:
    - framework_behavior
    - client_constraint
scope:
    - '**'
source_files:
    - src/feishu/lark-transport.ts
    - src/feishu/lark-cli.ts
    - package.json
---

### 传输层实现
- 使用官方底层 `WSClient + EventDispatcher`（而非高层 `LarkChannel`）建立长连接，因为卡片回调 handler 返回值需要原样进入 ACK 数据体（与 Go 官方 SDK 行为一致），且 LarkChannel 的去重逻辑会静默吞事件。
- 连接由官方 SDK 自动重连；应用层设置 15 秒握手超时、30 秒 ping 超时。
- 外部成员查询降级：当用户不在应用可见范围时，spawn 外部 `lark-cli contact +search-user` 补充部门/英文名，需以用户身份登录并具备搜索权限。
- 版本策略：精确锁版（无 `^`），升级需手动改版本号并回归收发消息、文件附件、授权卡点击、/model 切换等场景。
- 必需权限：`im:message`、`im:message.group_at_msg`、`im:message.p2p_msg`、`im:message.reaction:write`、`contact:user.base:readonly`、`im:chat.member:readonly`；可选 `im:resource` 用于图片附件。