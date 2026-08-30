# 自定义 Tools（Function Calling）

这里存放**用户自定义的工具**，系统会在启动时自动加载。

## 目录说明

```
.agent/tools/          # 用户自定义工具目录
├── README.md          # 本文件
├── get-time.ts        # 示例：获取时间工具
└── your-tool.ts       # 你的自定义工具
```

## 工具定义格式

每个工具是一个 TypeScript 文件，导出 `ToolDefinition` 对象：

```typescript
/**
 * 工具名称
 * 
 * 用途：工具的主要功能说明
 * 权限：default | team | admin
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const yourTool: ToolDefinition = {
  name: "tool_name",              // 工具唯一标识（snake_case）
  description: "工具用途说明",     // 给 AI 看的，决定何时调用
  permission: "default",          // 权限级别：default | team | admin
  input_schema: {                 // JSON Schema 格式
    type: "object",
    properties: {
      param1: { 
        type: "string", 
        description: "参数说明" 
      }
    },
    required: ["param1"]
  },
  
  /**
   * 执行工具逻辑
   */
  execute: async (toolCallId, params, signal) => {
    // 你的业务逻辑
    return "执行结果";
  }
};
```

## 权限控制

工具支持三级权限：

| permission | 可访问用户 |
|-----------|----------|
| `"default"` | 所有用户 |
| `"team"` | 团队成员 + 管理员 |
| `"admin"` | 仅管理员 |

未配置 `permission` 字段的工具默认为 `"default"`。

## 自动加载

系统启动时会：
1. 扫描 `.agent/tools/` 目录下的所有 `.ts` 和 `.js` 文件
2. 加载导出的 `ToolDefinition` 对象（支持 default export 和 named export）
3. 根据用户角色过滤可用工具
4. 注册到 Pi Agent 运行时

**修改工具后需要重启服务才能生效。**

## 示例工具

参考 `get-time.ts` 查看完整示例。

## 与 Skills 的区别

- **Skill**（`.agent/skills/`）：Markdown 指导文档，告诉 AI 如何思考和执行复杂流程
- **Tool**（`.agent/tools/`）：TypeScript 可执行代码，提供 AI 可直接调用的功能

详见项目 README.md 的 "Skills 与 Tools：定位与协作" 章节。

## 从 Skill 转换为 Tool

当一个 Skill 的流程固化后，可以转换为 Tool 以提升效率：

1. 在飞书对话中说："把 XXX skill 转成 tool"
2. AI 会自动读取 Skill、生成 Tool 代码、写入本目录
3. 确认后重启服务即可使用

## 常见场景

- **查询数据**：天气、时间、数据库查询
- **执行操作**：发送消息、创建工单、部署应用
- **外部 API**：飞书文档、多维表格、日历、审批
- **固定流程**：测试→构建→部署的自动化流程
