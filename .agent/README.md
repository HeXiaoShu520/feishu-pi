# .agent —— Agent 配置目录

**目录名是本工程自选的**（不是 Pi 的原生约定），但内部布局遵循 Pi 的规范。
本工程在创建 `DefaultResourceLoader` 时把 `agentDir` 显式指向这里（`src/runtime/feishu-pi-runtime.ts`），
于是 Pi 的原生资源槽位全部落在仓库内：随 git 走、团队共享、且 `SYSTEM.md` 不需要"项目信任"。

## Pi 原生约定的部分

| 文件/目录 | 作用 | Pi 的发现方式 |
|---|---|---|
| `SYSTEM.md` | **系统提示本体（身份 + 行为规则）** | `discoverSystemPromptFile()` → `<agentDir>/SYSTEM.md`，免信任 |
| `APPEND_SYSTEM.md` | 追加系统提示（预留，当前未使用） | `discoverAppendSystemPromptFile()` |
| `skills/` | 技能说明（只管"怎么做"，不含权限信息） | 扫描 `<agentDir>/skills` |
| `prompts/`、`themes/`、`extensions/` | Pi 的提示模板 / 主题 / 扩展（当前未使用） | 扫描同名目录 |

## 本工程自研的部分

| 文件/目录 | 作用 | 加载方 |
|---|---|---|
| `permissions.json` | 权限策略：`deny` + 各身份组的 `allow` 规则（fail-safe，未放行即拦截） | `src/permission/policy.ts` |
| `tools/` | 自定义工具（如 `memory.py`，注册为 Pi 的 `customTools`） | `src/runtime/feishu-pi-runtime.ts` |

> 注意：`tools/` **不是** Pi 的原生约定。Pi 的原生"自定义工具"机制是 `extensions/`（扩展代码），
> 与本目录的脚本约定不通用，不要为了名字好看而改名。

## 常见改动

- **改人设 / 加行为规则** → 编辑 `SYSTEM.md`，**需重启进程生效**（ResourceLoader 进程内只创建一次）。
- **改谁能用哪个工具 / 读写哪个路径** → 编辑 `permissions.json`。
- **加一个工具** → 在 `tools/` 放脚本，由运行时扫描注册。
- **加一项技能** → 在 `skills/` 放 `.md` 说明书。

## 相关

- 系统提示的加载结果会在启动日志里打印（来源路径、项目上下文文件、Skills/Tools 数量）；`SYSTEM.md` 缺失会显式告警。
- 仓库级的工程约定写在根目录 `AGENTS.md`，由 Pi 自动追加为项目上下文。
