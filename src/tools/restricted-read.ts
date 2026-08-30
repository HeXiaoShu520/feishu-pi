import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { normalize, relative } from "node:path";
import { readFile } from "node:fs/promises";

/**
 * 受限的 read 工具 - 只能读取 skills 目录
 */
export function createRestrictedReadTool(cwd: string, agentDir: string): ToolDefinition {
  return {
    name: "read",
    description: "读取技能文件内容",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "技能文件路径",
        },
      },
      required: ["file_path"],
    },
    execute: async (toolCallId: string, params: unknown, signal: AbortSignal | undefined) => {
      const { file_path } = params as { file_path: string };

      try {
        const normalized = normalize(file_path);

        // 允许读取的路径
        const allowedPaths = [
          ".agent/skills/",
          ".agent\\skills\\",
          ".pi/skills/",
          ".pi\\skills\\",
          ".agents/skills/",
          ".agents\\skills\\",
        ];

        // 检查是否在允许的项目路径中
        const rel = relative(cwd, normalized);
        const isAllowedProjectPath = allowedPaths.some(path => rel.startsWith(path));

        // 检查是否在全局 agent 目录
        const relToAgent = relative(agentDir, normalized);
        const isAllowedAgentPath = relToAgent.startsWith("skills/") || relToAgent.startsWith("skills\\");

        if (!isAllowedProjectPath && !isAllowedAgentPath) {
          return "⛔ 权限不足：只能读取技能文件";
        }

        const content = await readFile(normalized, "utf-8");
        return content;
      } catch (error) {
        return `读取失败：${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}
