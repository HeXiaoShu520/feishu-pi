import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface McpServerConfig {
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  include: string[];
  exclude: string[];
  timeoutMs: number;
}

/** Local configuration is the trust boundary. Secret values are referenced through ${ENV_NAME}. */
export async function loadMcpConfig(
  file: string,
  cwd: string,
): Promise<Map<string, McpServerConfig>> {
  const source = await readFile(file, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    },
  );
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("mcp.json 必须是对象");
  const raw = parsed as {
    mcpServers?: Record<string, Record<string, unknown>>;
  };
  const result = new Map<string, McpServerConfig>();
  if (raw.mcpServers === undefined) return result;
  if (
    !raw.mcpServers ||
    typeof raw.mcpServers !== "object" ||
    Array.isArray(raw.mcpServers)
  )
    throw new Error("mcpServers 必须是对象");
  for (const [name, input] of Object.entries(raw.mcpServers)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(name))
      throw new Error(`MCP 服务名无效: ${name}`);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error(`MCP 配置无效: ${name}`);
    if (input.enabled !== undefined && typeof input.enabled !== "boolean")
      throw new Error(`MCP enabled 必须是布尔值: ${name}`);
    if (input.enabled === false) continue;
    const configuredTransport =
      input.transport ?? input.type ?? (input.command ? "stdio" : "http");
    const transport =
      configuredTransport === "streamable-http" ? "http" : configuredTransport;
    if (!["stdio", "http", "sse"].includes(String(transport)))
      throw new Error(`MCP transport 无效: ${name}`);
    const command =
      typeof input.command === "string" ? expand(input.command) : undefined;
    const url = typeof input.url === "string" ? expand(input.url) : undefined;
    if (transport === "stdio" && !command)
      throw new Error(`MCP 缺少 command: ${name}`);
    if (transport !== "stdio") {
      if (!url) throw new Error(`MCP 缺少 url: ${name}`);
      const parsed = new URL(url);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        throw new Error(`MCP URL 无效: ${name}`);
    }
    const timeoutMs = input.timeoutMs ?? 60_000;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      Number(timeoutMs) < 1000 ||
      Number(timeoutMs) > 600_000
    )
      throw new Error(`MCP timeoutMs 无效: ${name}`);
    result.set(name, {
      transport: transport as McpServerConfig["transport"],
      command,
      url,
      timeoutMs: Number(timeoutMs),
      args: strings(input.args ?? [], "args").map(expand),
      cwd:
        typeof input.cwd === "string" ? resolve(cwd, expand(input.cwd)) : cwd,
      env: dictionary(input.env),
      headers: dictionary(input.headers),
      include: strings(input.include ?? ["*"], "include"),
      exclude: strings(input.exclude ?? [], "exclude"),
    });
  }
  return result;
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`MCP ${field} 必须是字符串数组`);
  return value as string[];
}
function dictionary(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("MCP env/headers 必须是对象");
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (typeof item !== "string")
        throw new Error(`MCP env/header 值必须是字符串: ${key}`);
      return [key, expand(item)];
    }),
  );
}
function expand(value: string): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, name: string) => {
      const result = process.env[name];
      if (result === undefined)
        throw new Error(`MCP 引用的环境变量未设置: ${name}`);
      return result;
    },
  );
}
