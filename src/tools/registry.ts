import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FeishuPiTool } from "../runtime/types.ts";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_BUILTIN_TOOLS = ["read", "write", "edit", "bash"] as const;

/**
 * 从 .agent/tools/ 加载用户自定义工具
 */
async function loadCustomTools(cwd: string): Promise<ToolDefinition[]> {
  const toolsDir = join(cwd, ".agent/tools");
  if (!existsSync(toolsDir)) return [];

  const tools: ToolDefinition[] = [];
  const files = readdirSync(toolsDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));

  for (const file of files) {
    try {
      const filePath = join(toolsDir, file);
      const module = await import(pathToFileURL(filePath).href);

      // 支持默认导出或命名导出
      const tool = module.default || Object.values(module).find((exp: any) => exp?.name && exp?.execute);

      if (tool && typeof tool === "object" && "name" in tool && "execute" in tool) {
        tools.push(tool as ToolDefinition);
      }
    } catch (error) {
      console.warn(`[Registry] 加载工具失败: ${file}`, error);
    }
  }

  return tools;
}

/**
 * 创建工具注册表（同步版本，用于兼容现有代码）
 */
export function createToolRegistry(tools: FeishuPiTool[] = []): ToolDefinition[] {
  return [...(tools as ToolDefinition[])];
}

/**
 * 创建工具注册表（异步版本，加载用户自定义工具）
 */
export async function createToolRegistryAsync(cwd: string, tools: FeishuPiTool[] = []): Promise<ToolDefinition[]> {
  const customTools = await loadCustomTools(cwd);
  return [...customTools, ...(tools as ToolDefinition[])];
}
