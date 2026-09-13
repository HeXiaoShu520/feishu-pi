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

## 3. 使用指南

### 3.1 准备（无需任何后台操作）

- scope 已内置代码默认：`contact:user.base:readonly`、`contact:user.department:readonly`、`contact:user.department_path:readonly`、`contact:department.base:readonly`（均为免审权限）；
- **实测结论（2026-09-13）**：这些权限即使未在后台预开通，`/login` 的同意页也会把它们列入"免审权限"区块——点「开通并授权」即一次性完成**自动开通 + 用户授权**，无需在开发者后台勾选、无需发布版本；
- 若未来某权限属于"需审批"类型，同意页会走申请/审批流，由管理员审批后生效。

### 3.2 管理员登录（开启用户资料查询通道）

> `/login` **仅支持私聊**：群聊中发送会被拒绝——群聊里授权链接可能被他人代点，存在身份冒用风险。

1. 重启服务后，**私聊**机器人发送 `/login`；
2. 机器人回复**授权卡**：一条授权链接 + 一个确认码，有效期约 5 分钟；
3. 点击链接 → 飞书授权页（提示"以你的名义访问你的相关数据"）→ 点击**同意**；
4. 原授权卡自动变为「✅ 授权成功（scope：…）」——之后所有用户资料查询（中文名/英文名/部门名）都用你的身份执行，无需再管。

> 授权页可能只显示部分权限：已开通且免审的权限可能被静默授予、不逐条列出。最终以成功卡片上显示的 scope 为准。

### 3.3 普通用户

现阶段**无需任何操作**：聊天、被查资料都不依赖普通用户的 token。未来"以本人身份"的能力（我的日历、我的文档等）上线后：使用该功能时机器人会**自动弹出补充授权卡**，点一次同意即可（增量授权，见第 5.4 节）。

### 3.4 日常续期（自动，无需操作）

- access_token 约 2 小时、refresh_token 约 30 天；
- 每次使用前自动检查：access 剩余不足 30 秒 → 自动用 refresh 换新（无感）；
- 只要 30 天内至少使用过一次，登录状态就会一直延续；token 落盘在 `data/user-tokens.json`，**重启服务不需要重新登录**。

### 3.5 退出登录

发送 `/logout` 清除本人 token（下次使用相关能力时重新授权）。

## 4. 端点与线协议（与官方 lark-cli 一致）

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

## 5. 多用户并行登录方案（核心设计）

### 4.1 身份隔离：一人一条 token，互不覆盖

- token 以 **openId 为键**存储在 `data/user-tokens.json`（一人一条，`{access_token, refresh_token, 双过期时间, scope, updated_at}`）；
- 授权完成后，机器人用 access token 反查**实际授权者**（`authen/v1/user_info`），token 绑定到**实际点同意的账号**名下——谁完成授权就绑定谁的飞书，任何人都可以通过 `/login` 绑定自己的身份；
- 即使链接被他人代点，token 也归实际点同意的人（经身份核实，不会冒记到发起人名下）；发起人重新 `/login` 即可绑定自己；
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
// 缺失     → 自动向**该用户与机器人的私聊**发"补充授权卡"（含 现有 ∪ 新增，按 openId 直发，
//            即使触发发生在群聊也不会把授权卡发进群里），本次返回 undefined
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

## 6. 安全边界

- **token 绑定实际授权账号**：授权完成后经 `authen/v1/user_info` 核实实际授权者并以其 openId 落库，杜绝"B 的 token 冒记到 A 名下"的错位；
- **`/login` 仅限私聊**：群聊中授权链接可能被他人代点，因此群聊内直接拒绝；增量授权卡也按 openId 直发到用户私聊，绝不进群；
- **scope 最小化**：默认只申请用户资料查询所需的最小集合（两个免审只读权限）；新能力上线时按需声明，经用户同意后追加；
- **执行闸门不绕过**：user token 只解决"以谁的身份调 API"；工具能否被调用仍由 `.agent/permissions.json` 的组策略与 ToolGuard 漏斗决定；
- **凭据不落代码**：token 存于 `data/user-tokens.json`（`.gitignore` 已排除 `data/`）；App Secret 不出现在 URL 与日志。

## 7. 已知限制

- **管理员 token 失效期间**，用户资料查询通道退化为"仅 openId"（新用户入库缺中文名），管理员重新 `/login` 后下一条消息自动恢复——不影响聊天主流程；
- **跨租户外部用户**不在本组织通讯录，contact API 查不到其资料，走群成员名单兜底（只有中文名，无英文名/部门）；
- **新 scope 需要重新授权**：能力新增所需 scope 后，用户须重新完成一轮 Device Flow（管理员或用户各自行）；
- 发起端点 `accounts.feishu.cn/oauth/v1/device_authorization` 未见于公开文档（与官方 lark-cli 行为核实一致），升级官方 SDK/CLI 后建议回归一次 `/login`。


## 8. 常见问题（FAQ）

**Q：授权页为什么只显示了一个权限？我申请的不是两个吗？**
A：授权页只展示**本次需要你同意的增量**。已在后台开通且免审的权限（如 `contact:user.base:readonly`）可能被静默授予、不逐条列出。以授权成功卡片上显示的 scope 为准；也可直接试一次用户资料查询验证。

**Q：如果后面用到的权限，我的 token 里其实已经有了，还会弹申请网页吗？**
A：不会。`ensureScopes` 先检查现有 token 的 scope 覆盖情况——已包含所需权限时直接静默返回 token；只有缺失时才发起新一轮授权，且弹出的页面只列缺失部分。

**Q：点同意后提示「授权失败：The auth method is not supported」？**
A：旧版本的缺陷——轮询 token 端点误用了 JSON 编码（官方要求表单编码），已修复。更新代码并重启后再试；若仍出现，说明运行的不是最新代码。

**Q：多久需要重新登录一次？**
A：refresh_token 有效期约 30 天。30 天内至少使用/触发过一次相关能力，就会自动续期、永不失效；完全闲置超过 30 天，或在飞书后台撤销了授权，才需要重新 `/login`。

**Q：重启服务需要重新登录吗？**
A：不需要。token 落盘在 `data/user-tokens.json`，重启后自动读取并继续静默刷新。

**Q：多人能同时登录吗？会互相覆盖吗？**
A：能。token 按各自 openId 隔离存储，多人并行授权互不干扰；同一用户重复触发会去重提示，不会叠加轮询。

**Q：授权成功了，功能还是提示缺权限？**
A：多半是对应 scope 未在开发者后台开通、或开通后未发布版本。开通 → 发布版本 → 重新 `/login` 即可。

**Q：想换一个飞书账号？**
A：先 `/logout` 清除当前授权，再用目标账号 `/login`。

**Q：授权链接被别人点开了会怎样？**
A：授权页绑定的是"实际点同意的账号"——别人点同意，机器人获得的是**那个人的**身份 token 并记录在他自己名下，与发起人无关、也不影响发起人。发起人随后重新 `/login` 即可绑定自己。

## 9. 实现与测试

- 实现：`src/feishu/user-auth.ts`（`UserAuthService` / `LoginCommand` / `LogoutCommand` / `ensureScopes`）；
- 接线：`src/main.ts`（装配，注入 `updateCard` / `sendCard` / `adminOpenId`）；
- 测试：`test/user-auth.test.ts`——覆盖指引卡、轮询三态、增量授权合并、静默刷新、失败清档、`/logout`（HTTP/时钟全部注入脚本化，无真实网络）；
- 同类实现参照：官方 lark-cli（`internal/auth/device_flow.go`，端点与本实现一致）、`E:\源丶工程\feishu-assiant`（Python 版同协议实现）。
