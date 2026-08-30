---
name: skill-to-tool
description: 将成熟的 Skill 转换为 Function Calling Tool
permission: admin
---

# Skill 转 Tool

当用户说"把 XXX skill 转成 tool"或"XXX 转成工具"时，执行以下流程：

## 1. 读取并分析 Skill

用 `read` 工具读取 `.agent/skills/{skill_name}.md`，分析：
- Skill 的流程步骤
- 需要的参数
- 输出格式

## 2. 判断是否适合转换

**✅ 适合转成 Tool：**
- 流程步骤固定，没有复杂分支
- 重复使用频率高
- 每个步骤都很明确，不需要 AI 灵活判断
- 需要外部 API 调用或复杂计算

**❌ 不适合转成 Tool：**
- 需要多轮对话和用户交互
- 流程步骤根据情况变化
- 需要 AI 灵活分析（如代码审查、调试分析）

如果不适合，向用户说明原因并建议保持 Skill。

## 3. 生成 TypeScript Tool 代码

根据 Skill 内容生成 `.agent/tools/{skill_name}.ts`：

**重要：生成的代码必须包含充分的注释**
- 文件头注释：说明工具用途、转换来源
- 每个关键步骤都要注释
- 复杂逻辑要解释原因

```typescript
/**
 * {工具名称} Tool
 * 
 * 用途：{工具的主要功能说明}
 * 来源：从 .agent/skills/{skill_name}.md 转换而来
 * 权限：{permission} - {权限说明}
 * 
 * 参数：
 *   - param1: {说明}
 *   - param2: {说明}
 * 
 * 返回：{返回值说明}
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const {camelCaseName}Tool: ToolDefinition = {
  name: "{snake_case_name}",
  description: "{从 Skill 提取的描述}",
  permission: "{从 Skill frontmatter 提取，默认 default}",
  input_schema: {
    type: "object",
    properties: {
      // 参数定义：根据 Skill 流程推断
      // 例如：如果 Skill 提到"指定环境"，就加 env 参数
    },
    required: [/* 必需参数列表 */]
  },
  
  /**
   * 执行工具逻辑
   * 
   * @param toolCallId - 工具调用 ID
   * @param params - 输入参数
   * @param signal - 中止信号
   * @returns 执行结果或错误信息
   */
  execute: async (toolCallId: string, params: unknown, signal: AbortSignal | undefined) => {
    // 类型转换：将 unknown 转为具体参数类型
    const input = params as { /* 参数类型 */ };
    
    try {
      // 步骤 1：{第一步做什么}
      // 将 Skill 的步骤转换为代码
      // 如果 Skill 里是 bash 命令，转成 exec() 调用
      
      // 步骤 2：{第二步做什么}
      // 如果是 API 调用，转成 fetch() 或相应的 SDK 调用
      
      // 步骤 3：{第三步做什么}
      // 如果是文件操作，转成 fs 操作
      
      // 返回执行结果
      return "执行结果";
      
    } catch (error) {
      // 错误处理：捕获异常并返回友好的错误信息
      return `执行失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }
};
```

## 4. 代码生成规则

### 参数推断
- 如果 Skill 提到"项目名"、"指定项目" → 添加 `project_name` 参数
- 如果提到"环境"、"staging/prod" → 添加 `env` 参数，用 enum 限制选项
- 如果提到"文件路径" → 添加 `file_path` 参数
- 如果提到"关键词"、"搜索" → 添加 `keyword` 参数

### 步骤转换
- **Bash 命令** → `const { exec } = require('child_process').promises; await exec("命令");`
- **HTTP 请求** → `const res = await fetch(url, {method, body}); const data = await res.json();`
- **文件读取** → `const { readFile } = require('fs/promises'); const content = await readFile(path, 'utf-8');`
- **文件写入** → `const { writeFile } = require('fs/promises'); await writeFile(path, content);`
- **飞书 API** → 使用项目中的 `feishuClient` 或相应 SDK

### 错误处理
- 所有异步操作都要 try-catch
- 返回明确的错误信息，不要抛出异常
- 如果某步失败，说明是哪一步失败了

### 权限继承
- Tool 的 `permission` 字段继承 Skill 的 `permission`
- 如果 Skill 没有 `permission`，默认使用 `"default"`

## 5. 写入文件并确认

用 `write` 工具将生成的代码写入 `.agent/tools/{skill_name}.ts`

然后询问用户：
- ✅ Tool 已创建，是否需要删除原 Skill？
- 📝 是否需要修改生成的代码？

## 6. 清理（可选）

如果用户确认删除原 Skill，说明：
- ⚠️ 删除后无法恢复，建议先测试 Tool 是否正常工作
- 确认后再删除 `.agent/skills/{skill_name}.md`

## 示例对话

```
用户：把 deploy-app 转成工具
AI：好的，我来读取 deploy-app skill 并分析...
    [读取 skill]
    这个 Skill 的流程很清晰：测试→构建→部署，适合转成 Tool。
    [生成代码]
    ✅ 已创建 .agent/tools/deploy-app.ts
    是否删除原 Skill 文件？

用户：先不删，我测试一下
AI：好的，可以直接在对话中测试：
    "部署应用到 staging 环境"
```

## 注意事项

- 生成的代码要**简洁清晰**，不要过度封装
- 如果 Skill 逻辑很复杂（超过 50 行），建议提示用户将逻辑抽到 `src/services/` 目录
- 如果 Skill 需要调用 Python 专属库，告知用户需要手动实现或保持 Skill 形式
- 转换后要验证 Tool 的 `input_schema` 是否完整，参数类型是否正确
