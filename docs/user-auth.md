# 用户飞书身份授权（Device Flow 与多用户并行登录）

本文说明 feishu-pi 的用户身份授权机制：为什么用它、流程怎么走、**一个服务实例如何同时支撑多个用户各自登录并并行使用**。实现位于 `src/feishu/user-auth.ts`（`UserAuthService`），指令入口为 `/login`、`/logout`。

## 1. 为什么需要用户身份授权

机器人平时用**应用身份**（tenant_access_token）调用飞书 API，能做的事情受应用权限与通讯录范围限制。有三类能力必须"以某个用户本人的身份"才能做：

- 搜索组织内的人（contact 搜索类接口只开放给用户身份）；
- 读取"我的"日历 / 待办 / 文档 / 审批等个人视角数据；
- 以用户名义执行操作（发消息、写文档，操作记录在用户名下）。

这类能力统一通过 `UserAuthService.getUserAccessToken(openId)` 拿该用户的 token；能力层只需声明"本次需要哪些 scope"，token 的获取、刷新、缺失引导全部由授权服务处理。

## 2. 为什么用 Device Flow

标准 OAuth 授权码流程要求一个公网 `redirect_uri` 接收回跳——而 feishu-pi 的典型部署环境（内网服务器、本机、家用电脑）没有公网 HTTPS。Device Flow（RFC 8628）把"授权动作"交给用户自己的浏览器/飞书客户端完成：

```text
机器人（服务器）                      飞书
     │  1. POST device_authorization     │
     │ ────────────────────────────────► │  返回 device_code + 授权链接 + 确认码
     │  2. 发授权卡给用户（链接 + 码）      │
     │ ◄──────── 用户在浏览器点同意 ────── │
     │  3. 按间隔轮询 token 端点           │
     │ ◄──────── 授权完成 → 签发 token ── │
```

全程无 redirect_uri、无公网回调、无重定向 URL 白名单配置。

## 3. 端点与线协议（与官方 lark-cli 一致）

| 步骤 | 端点 | 编码 | 关键参数 |
|------|------|------|---------|
| 发起 | `POST https://accounts.feishu.cn/oauth/v1/device_authorization` | 表单 | `client_id`、`scope`；鉴权头 `Authorization: Basic base64(appId:appSecret)` |
| 轮询 / 刷新 | `POST https://open.feishu.cn/open-apis/authen/v2/oauth/token` | 表单 | 见下 |
| 撤销 | `POST https://accounts.feishu.cn/oauth/v1/revoke` | 表单 | （预留，未接入） |

- 发起响应：`device_code` / `user_code` / `verification_uri(_complete)` / `expires_in`（默认 240s）/ `interval`（默认 5s）。
- **scope 自动追加 `offline_access`**——没有它飞书不签发 refresh_token，静默续期机制失效。
- 轮询请求：`grant_type=urn:ietf:params:oauth:grant-type:device_code` + `device_code` + `client_id` + `client_secret`，**表单编码**（JSON 编码会报 "The auth method is not supported"）。
- 轮询中间态以 HTTP 400 + RFC 风格 error body 返回：`authorization_pending`（继续）、`slow_down`（间隔 +5s，封顶 60s）、`access_denied` / `expired_token` / `invalid_grant`（终止）。
- 成功响应：`access_token` / `refresh_token` / `expires_in` / `refresh_token_expires_in` / `scope`。

## 4. 多用户并行登录方案（核心设计）

### 4.1 身份隔离：一人一条 token，互不覆盖

- token 以 **openId 为键**存储在 `data/user-tokens.json`（一人一条，`{access_token, refresh_token, 双过期时间, scope, updated_at}`）；
- 发起授权时 `device_code` 与**发起者 openId 绑定**，轮询到的 token 只落到发起者名下——不存在"用 A 的同意换 B 的 token"；
- 存储文件在 `data/` 下（已被 `.gitignore` 排除），读写经 JSON store 的**串行写队列 + 临时文件原子替换**，多用户并发授权/刷新不会写坏文件。

### 4.2 并行授权：不同用户互不阻塞

每个用户的授权流程是**独立的异步任务**，互不干扰：

```text
用户 A：/login → device_code_A → 授权卡 A → 后台轮询 A
用户 B：/login → device_code_B → 授权卡 B → 后台轮询 B     ← 与 A 完全并行
用户 C：正常聊天、触发其它用户的能力                            ← 不受任何授权流程影响
```

- 发卡后**立即返回**（后台任务轮询），不阻塞消息处理与指令回复；
- 轮询结果**原地更新**各自的授权卡（成功 ✅ / 拒绝 ❌ / 过期 ❌），A、B 的卡片互不影响；
- 同一用户重复触发（轮询进行中再发 `/login`）→ 去重提示"已有进行中的授权"，不会叠加轮询任务。

### 4.3 角色与默认 scope

| 角色 | `/login` 默认申请 | 用途 |
|------|------------------|------|
| 管理员（FEISHU_ADMIN） | `contact:user.base:readonly` + `contact:department.base:readonly` | 其 token 是**用户资料查询通道**的唯一凭据（中文名/英文名/部门名，见 `docs/architecture.md`） |
| 普通用户 | 同上（免审权限，同意成本低） | 为"以本人身份"的能力预备身份；使用需要更多权限的功能时走增量授权 |

普通用户**不强制登录**：不 `/login` 也能正常聊天和使用应用身份能力；只有用到需要用户身份的功能时才会被引导授权。

### 4.4 增量授权：用到啥再申请啥

飞书签发的 token 只包含**本次授权同意的 scope**——没有"在旧 token 上动态加权限"的协议。因此"追加权限"的标准做法是：**合并（现有 scope ∪ 新增 scope）重新发起一轮 Device Flow**，用户再点一次同意。

`ensureScopes(openId, chatId, needed)` 把这套流程自动化：

```ts
// 能力层示例：某功能需要日历权限
const token = await userAuth.ensureScopes(openId, ["calendar:calendar:readonly"]);
// 已具备   → 直接返回 access token，功能继续
// 缺失     → 自动向该会话发"补充授权卡"（含 现有 ∪ 新增），本次返回 undefined
//            能力层提示"已发送授权请求，完成后重试"；用户同意后下次调用即生效
```

- 增量申请范围 = 现有 scope ∪ 新增 scope（**避免已同意的权限被缩水**）；
- 新 token 入库后自动合并生效，旧能力不受影响；
- 授权完成后原卡更新为 ✅（scope 列表可见）。

### 4.5 token 生命周期

| 阶段 | 行为 |
|------|------|
| 读取（`getUserAccessToken`） | access token 剩余 >30s → 直接返回；否则进入刷新 |
| 静默刷新 | refresh token 有效 → 表单调 token 端点（`grant_type=refresh_token`）换新，**对调用方无感**；兼容 `refresh_token_expires_in` 字段名 |
| refresh 失效（撤销/超期） | 清除该用户档案，返回 `undefined`——能力层下次自动引导重新 `/login` |
| 冷却 | 授权卡失败原因明确（拒绝/过期/接口错误），重发即时；不做隐藏节流 |

### 4.6 失败隔离

单用户的授权失败**只影响该用户**：

- 轮询失败/超时只更新他自己的卡片，其他用户 token 与能力不受影响；
- 存储按用户隔离，一个人的撤销不会触碰他人档案；
- 后台任务是独立异步流，异常只记日志（`[UserAuth] 授权轮询异常`），不会向上抛断消息主流程。

## 5. 安全边界

- **本人授权本人**：device_code 与发起者 openId 绑定，卡片授权结果只写入发起者名下；
- **scope 最小化**：默认只申请用户资料查询所需的最小集合（两个免审只读权限）；新能力上线时按需声明，经用户同意后追加；
- **执行闸门不绕过**：user token 只解决"以谁的身份调 API"；工具能否被调用仍由 `.agent/permissions.json` 的组策略与 ToolGuard 漏斗决定；
- **凭据不落代码**：token 存于 `data/user-tokens.json`（`.gitignore` 已排除 `data/`）；App Secret 不出现在 URL 与日志。

## 6. 已知限制

- **管理员 token 失效期间**，用户资料查询通道退化为"仅 openId"（新用户入库缺中文名），管理员重新 `/login` 后下一条消息自动恢复——不影响聊天主流程；
- **跨租户外部用户**不在本组织通讯录，contact API 查不到其资料，走群成员名单兜底（只有中文名，无英文名/部门）；
- **新 scope 需要重新授权**：能力新增所需 scope 后，用户须重新完成一轮 Device Flow（管理员或用户各自行）；
- 发起端点 `accounts.feishu.cn/oauth/v1/device_authorization` 未见于公开文档（与官方 lark-cli 行为核实一致），升级官方 SDK/CLI 后建议回归一次 `/login`。

## 7. 实现与测试

- 实现：`src/feishu/user-auth.ts`（`UserAuthService` / `LoginCommand` / `LogoutCommand` / `ensureScopes`）；
- 接线：`src/main.ts`（装配，注入 `updateCard` / `sendCard` / `adminOpenId`）；
- 测试：`test/user-auth.test.ts`——覆盖指引卡、轮询三态、增量授权合并、静默刷新、失败清档、`/logout`（HTTP/时钟全部注入脚本化，无真实网络）；
- 同类实现参照：官方 lark-cli（`internal/auth/device_flow.go`，端点与本实现一致）、`E:\源丶工程\feishu-assiant`（Python 版同协议实现）。
