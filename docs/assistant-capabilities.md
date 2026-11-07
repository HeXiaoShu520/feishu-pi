# 能力使用与适配

## 配置概览

| 配置 | 默认或用途 |
|---|---|
| `FEISHU_PI_OWNER` | 唯一使用者的飞书 Open ID，启动前配置 |
| `FEISHU_PI_BROWSER_CHANNEL` | Windows 默认 msedge；其他平台默认 chrome |
| `FEISHU_PI_USER_CLI` | 默认 0；显式允许本人主动授权的用户态 CLI 时设 1 |
| `FEISHU_GUARD_BASE_URL / MODELS / API_KEY` | ask 审核接口；未配置时本人确认 |
| `.agent/permissions.json` | deny / ask / allow，mtime 重载 |
| `.agent/mcp.json` | MCP 服务；使用时读取，变更后重新连接 |

旧模型、飞书应用和资源上限的 `FEISHU_PI_*` 配置仍可继续使用，详见 `.env.example`。

## 浏览器

工程依赖固定版本的官方 `@playwright/cli`，不需要全局安装。使用电脑上已有的 Edge/Chrome，不在开机时启动浏览器。

工具名为 `browser`：

```json
{"action":"open","url":"https://example.com"}
{"action":"snapshot"}
{"action":"find","text":"登录"}
{"action":"fill","ref":"e12","text":"填写内容"}
{"action":"click","ref":"e15"}
{"action":"screenshot"}
{"action":"show"}
{"action":"close"}
```

以上是逐次调用示例。元素 ref 必须来自当前页面快照，页面变化后重新获取。填写、点击、上传等动作进入 ask 审核；upload 同时检查 Read(path)。操作后检查页面实际结果。

还支持标签页、导航、键盘、选择框、勾选框和对话框；完整列表在工具 schema。profile 固定为 `data/browser/profile`，多个会话共享本人浏览器，操作串行执行。使用独立 profile，因此第一次登录需要本人完成，之后保留登录状态。

`show` 打开接管面板；验证码或需要本人确认的网站流程由本人处理。默认浏览器空闲 15 分钟后关闭；正常服务退出也会关闭。失败、超时不自动重放点击、提交等动作。

目前未提供任意桌面软件控制、Cookie 导出或通用网页搜索 API。浏览器可以打开搜索网站；这些独立能力不在本次实现范围。

实现：`src/browser/service.ts` 管理 CLI 与状态，`src/browser/tool.ts` 管理参数和结果。参考：[官方 Playwright CLI](https://github.com/microsoft/playwright-cli)。

## 记忆

本人飞书私聊使用 Memoria 自动提炼，并以 Aurabot 的 BM25 和遗忘曲线召回，数据位于 `data/companion-memory/`；每轮提炼调用当前模型，群聊不注入私人记忆。旧版 `memory` 工具代码已移除，原有数据保留在 `data/memory/`，不会自动导入。

## 后台任务

工具名为 `background_task`：

```json
{"action":"start","name":"生成报告","command":"python report.py","cwd":"E:/自己的项目","timeoutMs":1800000}
{"action":"status","id":"start 返回的任务 ID"}
{"action":"log","id":"任务 ID","maxBytes":16000}
{"action":"cancel","id":"任务 ID"}
{"action":"list"}
```

默认工作目录为当前会话目录，cwd 可以显式设置。只支持 Bash 命令，与前台 bash 使用同一身份通道；命令内容另走 Bash 权限。模型不能用允许的 background_task 工具包装被 deny 的命令。

默认并发上限 3、超时 30 分钟，最长 24 小时；每项日志最多 10 MiB，超过后继续运行并标记日志截断。status 区分 running、succeeded、failed、cancelled、timed_out 和 interrupted。退出码 0 只证明进程结束成功，业务结果仍要检查。

任务结束通过机器人应用发送通知，不调用模型。任务通知回到原飞书聊天。通知失败记录日志，任务记录仍可查询。

正常退出会停止任务和进程树，清理凭证代理。任务状态跨重启保留，进程不恢复；重启前的运行任务标记 interrupted，不自动重跑。

实现：`src/tasks/service.ts` 管理状态和资源；`tool.ts` 只派发操作；`runtime/identity-bash.ts` 提供共享身份租约。

## MCP

配置 `.agent/mcp.json`，默认无服务。下面是两种可选配置示例，地址、路径与环境变量应换成实际值：

```json
{
  "mcpServers": {
    "files": {
      "transport":"stdio",
      "command":"npx",
      "args":["-y","@modelcontextprotocol/server-filesystem","E:/自己的工作目录"],
      "include":["*"],
      "exclude":[],
      "timeoutMs":60000
    },
    "remote": {
      "enabled":false,
      "transport":"http",
      "url":"https://你的服务/mcp",
      "headers":{"Authorization":"Bearer ${MY_MCP_TOKEN}"},
      "include":["*"],
      "timeoutMs":60000
    }
  }
}
```

这个例子不会随仓库配置自动启用。生产使用时推荐固定 MCP 服务的版本并缩小其文件根目录。stdio 子进程只继承系统运行环境；只有 env 字段明确声明的额外变量才会注入。headers/env 支持 `${ENV_NAME}`；缺少变量时报错，不把空密钥发送出去。

工具名为 `mcp`，采用按需发现，避免把所有 MCP schema 常驻塞进每次请求：

```json
{"action":"servers"}
{"action":"discover","server":"files"}
{"action":"call","server":"files","tool":"发现结果中的原始工具名","args":{}}
{"action":"resources","server":"files"}
{"action":"read_resource","server":"files","uri":"服务返回的 URI"}
{"action":"prompts","server":"files"}
{"action":"get_prompt","server":"files","prompt":"服务返回的提示名","args":{}}
{"action":"disconnect","server":"files"}
```

调用工具前先 discover，查看 inputSchema。发现结果同时返回 `permissionName`，例如 `mcp__files__某工具_校验后缀`；可在权限文件中使用 Tools(permissionName) 精确匹配。默认 ask 的 `Tools(mcp__*)` 会审核所有具体 MCP 工具。

include/exclude 匹配服务原始工具名，exclude 优先；禁止的工具不能通过通用 call 入口执行。服务器描述、提示和资源内容都是不可信资料。MCP annotations 不能自动豁免权限。

使用官方 SDK 校验协议和工具 schema，支持取消、超时和断线后重新连接。明确设置 transport=sse 可连接旧 SSE 服务；不会在一次调用失败后自动换传输重试。当前没有 OAuth 自动注册、远端账号管理或 MCP sampling；需要认证的服务使用明确的本地配置。

实现：`src/mcp/config.ts` 解析配置，`service.ts` 管理连接，`tool.ts` 适配结果，`names.ts` 生成稳定权限名。参考：[官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。

## 后续扩展约定

给新能力写独立服务，再写 Pi 工具适配；通过 AssistantServices/main 注入依赖和生命周期。复用 CLI 时使用直接 argv，明确环境变量来源、输出大小、取消和超时。新增嵌套执行器时，把底层能力投影到 ToolGuard，避免通用工具成为权限旁路。

技能可以编排这些工具；进程、凭证、索引和连接的状态由服务层持有。工具使用时机写在 description，恒真行为约束写在 SYSTEM.md。
