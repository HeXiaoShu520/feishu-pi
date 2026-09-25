# 用户身份授权

## 身份分工

机器人身份用于收发消息和卡片；飞书用户 token 用于以当前用户身份调用 CLI；Meegle token 用于飞书项目。它们按 provider 和 openId 分开保存，不应混用。

机器人启动不要求任何用户登录。运行中可私聊 `/login lark` 或 `/login meegle`，也可由当前用户缺凭证的工具调用自动发起授权。群内登录指令会提示转到私聊，自动授权链接也只发本人私聊。

## 飞书授权流程

1. 发起 Device Flow，取得授权链接和 device_code。
2. 用户在浏览器完成授权，后台按服务端间隔轮询；slow_down 增加间隔，拒绝、过期和超时结束。
3. 取得 token 后调用身份接口核实实际授权者，以实际 openId 保存；身份核实失败则不保存。别人代点时不会把他的 token 记在发起者名下。
4. 本次工具调用需重试；授权完成不会自动重放业务操作。

默认申请 `contact:contact.base:readonly`、`contact:user.base:readonly`、`contact:department.base:readonly`，并附加 `offline_access`。`FEISHU_USER_AUTH_SCOPES` 可覆盖业务 scope。是否可用取决于飞书应用的实际权限和用户授权结果。

当前用户实际执行用户态命令前，按需加载或刷新其 access token；同用户并发刷新合并。启动与后台定时任务不遍历、刷新其他用户凭证。refresh token 过期需重新授权，实际有效期以接口返回为准，不保证永久续期。

`ensureScopes` 合并已有和新 scope 发起增量授权。普通消息发送者资料只读已有缓存和本人登录返回的姓名；没有资料时显示 `open_id`。唯一允许使用管理员用户 token 的自动查询是：消息中真实 @ 了其他人时，预处理程序查询被 @ 者资料并缓存；AI 不参与或取得该 token。

## 执行与存储

`identity-bash.ts` 在 shell 中提供 `lark-cli`、`lark` 和 `meegle` 入口。shell 自行处理 `cd`、`;`、`&&`、管道和重定向；每条 CLI 真正启动时，本地身份通道才把当前发起人的凭证交给该 CLI 子进程。普通 `cat`、`tail`、`ls` 等 shell 命令不接收真实用户 token 或机器人密钥。省略身份或 `--as user` 使用当前发消息者；显式 `--as bot` 使用当前机器人应用的 App ID/Secret。管理员用户令牌仅供固定资料入库；管理员本人发起的 AI CLI 用户态调用也会拒绝。每次调用使用独立临时 CLI 配置目录；shell 环境另设无效的用户令牌，直接调用本机 CLI 时也不应回退到本机登录缓存。当前用户没有有效凭证时拒绝该次 CLI 执行。简单命令可按白名单直通；复杂 shell 语法仍由工具门禁审核，身份处理不等于白名单放行。

飞书凭证在 `data/credentials/lark.vault.json`，Meegle 凭证在 `data/credentials/meegle.vault.json`，主密钥在 `data/.vault-key`。文件加密使用 AES-256-GCM；同一数据目录只支持单进程写入。

Meegle 当前通过 Device Flow 获得静态 token，不实现自动刷新；重新授权后替换。其绑定以私聊发起者为准，没有飞书 UserAuthService 那样的授权后 openId 反查，应避免转发授权链接。

`/status` 查看登录状态；`/logout lark` 或 `/logout meegle` 清除指定本地凭证；`/logout` 清除两者。本地退出不等于在飞书端撤销应用授权。

## 边界

用户 token 决定业务接口身份；工具调用仍经过权限和审核。普通群、话题历史是共享的，工具结果进入共享上下文，个人敏感查询请使用私聊。文件权限和凭证加密不能替代操作系统对 shell 的隔离。

接口与 CLI 兼容性由 `user-auth.ts`、`meegle-device-flow.ts` 和测试维护；升级依赖后需要真人回归授权链接、scope 同意、刷新和退出流程。
