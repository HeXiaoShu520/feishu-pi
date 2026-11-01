import { createHash } from "node:crypto";

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}__${tool.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 45)}_${createHash("sha256").update(tool).digest("hex").slice(0, 6)}`;
}
