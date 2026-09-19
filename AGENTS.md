# feishu-pi

飞书机器人形态的智能体服务：以 Pi AgentSession 为内核，接入飞书消息与卡片，模型能力受 `.agent/permissions.json` 权限策略约束。

## 常用命令

- 启动：`npm start`（`tsx src/main.ts`）
- 开发热重载：`npm run dev`
- 类型检查：`npm run check`
- 测试：`npm test`（vitest）
- 初始化向导：`npm run setup`

## 目录结构

- `src/` — 源码
  - `main.ts` 装配与启动
  - `feishu/` 飞书接入（消息、卡片、传输、用户授权）
  - `runtime/` Pi 运行时封装（会话、资源加载、系统提示）
  - `permission/` 权限策略解析
  - `guard/` 工具调用审核（策略外调用弹授权卡）
- `.agent/` — Agent 配置目录（详见 `.agent/README.md`）
  - `SYSTEM.md` 系统提示 / 人格（pi 原生发现，本仓库的 agentDir 指向此目录）
  - `skills/` 技能（pi 原生约定）
  - `permissions.json` 权限策略（本工程自研）
  - `tools/` 自定义工具（本工程自研）
- `data/` — 非会话运行时数据（记忆、用户、凭证、会话索引、共享缓存），已被 `.gitignore` 排除
- `work_space/` — 会话目录根：一次会话一个目录（`{sessionId}/`），jsonl、图片、附件、OCR 过程文件全在里面
- `docs/` — 架构与命令文档：`architecture.md`、`commands.md`

## 约定与已知坑

- **给模型的指令集中在 `.agent/SYSTEM.md`**。pi 自行发现 `<agentDir>/SYSTEM.md`（本仓库 `agentDir = <仓库>/.agent`），代码里不再有自写的人格/规则常量。
- **指令分层准则**：`.agent/SYSTEM.md` 只写「与工具无关的恒真约束」（身份、口吻、安全行为、输出形态）；凡「某个工具怎么用 / 什么时候用」的策略，一律写在该工具的 `description` 里（如 `src/feishu/memory-tool.ts` 返回对象上的 `description` 字段）。工具描述随注册进入请求，注册与否自动同增同减；写进静态的 `SYSTEM.md` 就会出现「提示教模型用一个不存在的工具」。
- **本文件由 pi 自动追加为项目上下文**（`<project_context><project_instructions>`），无需任何自写加载代码。
- pi 的 `promptSnippet` / `promptGuidelines` 在本工程**不会生效**：`buildSystemPrompt` 在 customPrompt（= `SYSTEM.md`）分支会提前 `return`，这两个字段只在 pi 的默认提示分支被消费，别在这上面绕。
- 项目上下文有白名单（`agentsFilesOverride`）：只接受工程目录内的文件，避免祖先目录（含盘根）的 `AGENTS.md` 不经任何信任检查地进入系统提示。
- 改动 `.agent/SYSTEM.md` **需要重启进程**才生效（ResourceLoader 在进程内只创建一次）。
- 权限是 **fail-safe**：`permissions.json` 未明确放行的调用一律拦截，规则写错的表现是"工具全不可用"而不是"全部放行"。
- 思考档位支持 `off` / `low` / `high` / `max`，默认 `off`；旧档位 minimal/medium/xhigh/ultra 会告警并折算，未知值告警后回退 `off`。
- `.gitignore` 忽略了 `.pi/`，配置不要放到 `.pi/`（会被静默排除出版本库）。
- 模型与档位等运行时配置走 `.env`（不入库），字段说明见 `.env.example`。
