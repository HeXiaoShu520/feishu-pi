import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FeishuPiTool } from "../runtime/types.ts";

export const DEFAULT_BUILTIN_TOOLS = ["read", "write", "edit", "bash"] as const;

export function createToolRegistry(tools: FeishuPiTool[] = []): ToolDefinition[] {
  return tools as ToolDefinition[];
}
