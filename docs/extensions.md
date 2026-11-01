# Skill、Tool 与 MCP

三种入口分别扩展流程说明、本地执行能力和外部服务。业务实现放在各自模块，飞书只负责消息与交互；注册选择和执行授权由不同配置负责。

| 类型 | 放在哪里 | 提供给模型的内容 | 执行入口 |
|---|---|---|---|
| Skill | `.agent/skills/name/SKILL.md`，也支持顶层 `name.md` | 名称、描述、文件路径；正文按需读取 | 模型使用已注册工具完成流程 |
| Tool | `.agent/tools/name.ts` 或 `name/index.ts` | description、参数 schema | 经过 ToolGuard 后执行 TS/JS |
| 独立脚本 | 工具目录内的 `run.ts` 等，由入口引用 | 仍使用 Tool 的描述和 schema | 受限环境的 Node 子进程 |
| MCP | `.agent/mcp.json` | 通用 mcp 工具；按需发现服务工具的 schema | 具体 permissionName 经审核后调用服务 |

## 资源选择和权限

`.agent/resources.json` 只控制 Skill 和自定义 Tool 的发现/注册：

```json
{
  "skills": {
    "enabled": true,
    "paths": [],
    "include": ["*"],
    "exclude": ["unused-*"]
  },
  "tools": {
    "enabled": true,
    "include": ["local_time", "json_format"],
    "exclude": []
  }
}
```

include/exclude 按资源名匹配 glob，exclude 优先；include 为空数组表示不注册任何条目。默认仅发现工程 `.agent/skills`，不自动读入电脑全局 Skill 目录。skills.paths 可显式添加额外的文件或目录，路径相对工程根目录解析，也可使用绝对路径。

tools.enabled=false 时不扫描、不导入工具模块。按工具名筛选发生在模块导入后，模块顶层应只定义对象，不在导入时启动进程或连接服务。整个工具模块及其辅助代码都属于本人信任的本地代码。

`.agent/permissions.json` 控制注册后的执行，例如将 `Tools(local_time)` 加入 allow，将 `Tools(json_format)` 加入 ask。添加到原有数组，保留已有规则。deny 硬拒绝，高风险本人确认，ask 模型审核，allow 放行，未匹配拒绝。注册选择不能替代执行授权。

修改 Skill、Tool、SYSTEM.md、resources.json 后重启；修改权限文件按 mtime 生效。MCP 配置在使用时重新读取，变化后重新连接。

## Skill

推荐标准目录结构：

```text
.agent/skills/my-workflow/
  SKILL.md
  references/
  scripts/
```

```markdown
---
name: my-workflow
description: 说明适用任务，使模型能判断何时读取此技能。
---

# 操作流程

写清前置条件、执行步骤和完成标准。
详细资料放在 references；固定能力调用已经注册的工具。
```

Pi 把 Skill 的短描述和路径加入提示，模型匹配任务后读取正文；支持相对路径引用和 `disable-model-invocation: true`。显式调用使用 `/skill:my-workflow 任务内容`，由 Pi 的 prompt 处理。

Skill 中的脚本不会自动注册为 Tool。模型通过 bash 执行它时审核 Bash；需要稳定的结构化参数时，将脚本封装为 Tool。

可以迁移 OpenClaw 的标准 SKILL.md 正文和辅助文件，但依赖必须逐项核对。本工程没有实现 OpenClaw 的 metadata.openclaw.requires、安装器、command-dispatch、专用工具名及插件 SDK，不能把这些字段视为已兼容。只有依赖当前可用工具的流程能直接复用。未满足依赖的技能可先在 exclude 中停用。[OpenClaw Skill 约定](https://docs.openclaw.ai/tools/skills)

## 进程内 TS 工具

可用示例：[local-time.ts](../examples/tools/local-time.ts)。复制到 `.agent/tools/local-time.ts` 后设置注册与权限规则。

```ts
import { defineTool } from "../../src/tools/sdk.ts";

export default defineTool<{ text: string }>({
  name: "normalize_text",
  description: "去掉文本首尾空白，用于确定性的文本清理。",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  execute: ({ text }, { signal }) => {
    signal?.throwIfAborted();
    return text.trim();
  },
});
```

defineTool 只提供轻量适配：类型、元数据校验、取消信号和有长度上限的文本结果。业务函数接收参数与 `{ cwd, signal }`，cwd 是工程根目录，返回字符串或 JSON；错误直接 throw。signal 应传给 fetch 等 API。

原生模块在服务进程内运行，可访问其环境和文件，不能强制终止同步死循环，也没有自动硬超时。耗时或需要回收的任务使用独立脚本。Tools(name) 审核一次调用，不会逐条审核模块内部每次文件/API 操作；业务逻辑需要自行限定参数和访问范围。

需要图片、增量进度、Pi 上下文或其他原生字段时，直接导出完整 ToolDefinition。加载器保留这些字段；支持 default、tool、tools 导出，单对象或对象数组。name 唯一，parameters 必须是 object JSON Schema，description 非空。缺失导出、非法 schema、重复名称或内置名称冲突都会明确中止启动。

## 独立 TS 脚本

完整可用示例：[json-format](../examples/tools/json-format/index.ts)。将整个目录复制到 `.agent/tools/json-format/`；入口导入路径与原位置兼容。

```text
.agent/tools/json-format/
  index.ts   # Tool 元数据和 defineScriptTool
  run.ts     # 独立业务脚本，不自动注册
```

defineScriptTool 的 script 推荐使用 `new URL("./run.ts", import.meta.url)`，避免依赖当前目录。字符串路径相对工程根目录解析。

- TS 由工程的 tsx 执行，JS/MJS 使用 Node；无需额外安装 Python。
- stdin 接收 JSON 参数，stdout 输出文本或 JSON 数据；stderr 输出诊断。
- 默认超时 30 秒，可设置 timeoutMs，最大 10 分钟。
- 非零退出码、取消、超时或输出超限都会报错，不能伪装成成功结果。
- 子进程只继承系统环境，不继承模型、飞书应用或用户令牌；使用 argv 启动，不拼 shell。
- 取消/超时回收进程树；大量输出应保存到文件并返回路径。
- 兼容原有带元数据头的 Python 工具；新独立脚本也可由 TS 入口使用 `src/process/runner.ts` 的 runProcess 调用。

## MCP

连接配置独立放在 `.agent/mcp.json`，默认没有服务。已经具备：stdio、Streamable HTTP、显式 legacy SSE；工具发现/调用、资源、资源模板、提示、取消、超时及断开回收。

```json
{
  "mcpServers": {
    "remote": {
      "transport": "streamable-http",
      "url": "https://你的实际服务地址/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" },
      "include": ["search_*"],
      "exclude": [],
      "timeoutMs": 60000
    }
  }
}
```

将 URL 改为实际服务地址，MCP_TOKEN 写入本地 .env。stdio 的 command 指向实际可执行程序，args 是 argv 数组，cwd 相对工程根目录解析，env 可显式引用所需变量。单个服务设置 enabled=false 可停用。transport 支持 http/streamable-http 别名，也接受常见 type 字段；OpenClaw 的整份配置仍需提取为 mcpServers 结构。

模型先调用 mcp.servers，再 discover，取得工具 schema 和 permissionName。call 会按具体的 `mcp__服务__工具` 重新审核，按 inputSchema 校验参数；allow 通用 mcp 工具不代表放行所有外部操作。

发现接口读取全部分页，并限制页数和拒绝重复游标。resource_templates 提供 URI 模板，模型填入实际参数后调用 read_resource。远端提示作为资料返回，不升级为系统指令。工具 schema 按需发现，不在启动时全部塞进系统提示。

目前没有远端 MCP 的交互式 OAuth 登录流程；需登录的服务通过明确配置的令牌/headers 接入。未来可在 MCP 连接层增设 OAuth 适配，保持业务工具独立。

## 查看结果与模块边界

`npm run resources` 列出当前 Skill、Tool 和 MCP 配置，不连接飞书或 MCP。它会导入工具模块；模块导入阶段应无业务副作用。`npm run check` 包括源码、`.agent/tools` 及示例的 TypeScript 类型检查。

| 模块 | 职责 |
|---|---|
| src/resources/config.ts | 解析扩展选择配置 |
| src/resources/pi-loader.ts | Pi 原生资源发现的选择与项目上下文边界 |
| src/resources/catalog.ts | 缓存一份资源快照 |
| src/tools/registry.ts | 发现入口，检查名称冲突，选择注册工具 |
| src/tools/module-loader.ts | 导入和校验工具定义 |
| src/tools/sdk.ts、script-tool.ts | 工具与独立脚本适配 |
| src/process/runner.ts | 系统环境、stdin/argv、超时和回收 |
| src/mcp/ | 协议配置、连接生命周期和工具适配 |
| src/guard/ | 统一执行授权 |

下一步能力建议见 [OpenClaw 对齐路线](openclaw-alignment.md)。
