import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { isAbsolute, relative, resolve } from "node:path";
import { readFile } from "node:fs/promises";

/** 允许读取的技能目录（相对 cwd，统一为正斜杠后做前缀匹配） */
const ALLOWED_PREFIXES = [".agent/skills/", ".pi/skills/", ".agents/skills/"];

/**
 * 受限的 read 工具——非管理员的"read"：只能读取技能目录下的文件，
 * 其余路径一律拒绝，防止普通用户读取 .env、源码、会话记录等敏感数据。
 *
 * @param cwd      工作目录（路径判断的基准）
 * @param agentDir 全局 agent 目录（其下 skills/ 同样放行）
 */
export function createRestrictedReadTool(cwd: string, agentDir: string): ToolDefinition {
  return {
    name: "read",
    label: "读取技能文件",
    description: "读取技能文件内容",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "技能文件路径",
        },
      },
      required: ["file_path"],
    },
    // 签名由 Pi 的 ToolDefinition 约定，toolCallId/signal/onUpdate/ctx 本工具用不到
    execute: async (_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: any, _ctx: any): Promise<AgentToolResult<unknown>> => {
      const { file_path } = params as { file_path: string };

      try {
        // 相对路径以 cwd 为基准解析成绝对路径（避免依赖进程 cwd 造成判断错位）
        const target = isAbsolute(file_path) ? file_path : resolve(cwd, file_path);
        // 统一为正斜杠，Windows 下也能做前缀匹配
        const rel = relative(cwd, target).replace(/\\/g, "/") + "/";
        const relToAgent = relative(agentDir, target).replace(/\\/g, "/") + "/";

        const isAllowedProjectPath = ALLOWED_PREFIXES.some((prefix) => rel.startsWith(prefix));
        const isAllowedAgentPath = relToAgent.startsWith("skills/") && !relToAgent.includes("..");

        if (!isAllowedProjectPath && !isAllowedAgentPath) {
          return { content: [{ type: "text", text: "⛔ 权限不足：只能读取技能文件" }], details: {} };
        }

        const content = await readFile(target, "utf-8");
        return { content: [{ type: "text", text: content }], details: {} };
      } catch (error) {
        return { content: [{ type: "text", text: `读取失败：${error instanceof Error ? error.message : String(error)}` }], details: {} };
      }
    },
  };
}

