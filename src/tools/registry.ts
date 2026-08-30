import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FeishuPiTool } from "../runtime/types.ts";
import { getTimeTool } from "./get-time.ts";

export const DEFAULT_BUILTIN_TOOLS = ["read", "write", "edit", "bash"] as const;

// 默认自定义工具
const DEFAULT_CUSTOM_TOOLS: ToolDefinition[] = [
  getTimeTool,
];

export function createToolRegistry(tools: FeishuPiTool[] = []): ToolDefinition[] {
  return [...DEFAULT_CUSTOM_TOOLS, ...(tools as ToolDefinition[])];
}
