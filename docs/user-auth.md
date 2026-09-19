# 用户身份授权

## 身份分工

机器人身份用于收发消息和卡片；飞书用户 token 用于以当前用户身份调用 CLI；Meegle token 用于飞书项目。它们按 provider 和 openId 分开保存，不应混用。

首次无登录记录时，交互启动会在终端引导 Device Flow。运行中可私聊 `/login lark` 或 `/login meegle`，也可由缺凭证的工具调用自动发起授权。群内登录指令会提示转到私聊，自动授权链接也只发本人私聊。

## 飞书授权流程

1. 发起 Device Flow，取得授权链接和 device_code。
2. 用户在浏览器完成授权，后台按服务端间隔轮询；slow_down 增加间隔，拒绝、过期和超时结束。
3. 取得 token 后调用身份接口核实实际授权者，以实际 openId 保存；身份核实失败则不保存。别人代点时不会把他的 token 记在发起者名下。
4. 本次工具调用需重试；授权完成不会自动重放业务操作。

默认申请 `contact:contact.base:readonly`、`contact:user.base:readonly`、`contact:department.base:readonly`，并附加 `offline_access`。`FEISHU_USER_AUTH_SCOPES` 可覆盖业务 scope。是否可用取决于飞书应用的实际权限和用户授权结果。

access token 临近到期时刷新；同用户并发刷新合并，后台每 30 分钟预热所有已登录用户。refresh token 过期需重新授权，实际有效期以接口返回为准，不保证永久续期。

`ensureScopes` 合并已有和新 scope 发起增量授权。资料查询使用 `lark-cli contact +search-user`，按目标本人 token、管理员 token 的顺序尝试。

## 执行与存储

`identity-bash.ts` 为每个子进程现取当前会话用户凭证。省略身份或 `--as user` 使用用户身份；显式 `--as bot` 不注入用户 token。用户态调用没有有效凭证时拒绝执行，避免使用机器上其他账号的 CLI 缓存。

飞书凭证在 `data/credentials/lark.vault.json`，Meegle 凭证在 `data/credentials/meegle.vault.json`，主密钥在 `data/.vault-key`。文件加密使用 AES-256-GCM；同一数据目录只支持单进程写入。

Meegle 当前通过 Device Flow 获得静态 token，不实现自动刷新；重新授权后替换。其绑定以私聊发起者为准，没有飞书 UserAuthService 那样的授权后 openId 反查，应避免转发授权链接。

`/status` 查看登录状态；`/logout lark` 或 `/logout meegle` 清除指定本地凭证；`/logout` 清除两者。本地退出不等于在飞书端撤销应用授权。

## 边界

用户 token 决定业务接口身份；工具调用仍经过权限和审核。普通群、话题历史是共享的，工具结果进入共享上下文，个人敏感查询请使用私聊。文件权限和凭证加密不能替代操作系统对 shell 的隔离。

接口与 CLI 兼容性由 `user-auth.ts`、`meegle-device-flow.ts` 和测试维护；升级依赖后需要真人回归授权链接、scope 同意、刷新和退出流程。
