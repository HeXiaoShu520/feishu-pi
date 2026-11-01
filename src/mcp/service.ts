import {
  Client,
  StreamableHTTPClientTransport,
  SSEClientTransport,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { processEnvironment } from "../process/environment.ts";
import { matchGlobs } from "../utils/path-glob.ts";
import { loadMcpConfig, type McpServerConfig } from "./config.ts";
import { mcpToolName } from "./names.ts";
import { logger } from "../utils/logger.ts";
import { collectPages } from "./pagination.ts";

interface McpConnection {
  client: Client;
  config: McpServerConfig;
  tools?: Tool[];
}

/** Lazy connections, no tool execution replay and no polling. SDK handles framing, negotiation and cancellation. */
export class McpService {
  private readonly file: string;
  private readonly cwd: string;
  private readonly connections = new Map<string, Promise<McpConnection>>();
  private readonly validator = new AjvJsonSchemaValidator();
  private readonly shutdown = new AbortController();
  private closed = false;
  constructor(options: { file: string; cwd: string }) {
    this.file = options.file;
    this.cwd = options.cwd;
  }

  async servers() {
    return [...(await loadMcpConfig(this.file, this.cwd))].map(
      ([name, config]) => ({
        name,
        transport: config.transport,
        connected: this.connections.has(name),
      }),
    );
  }

  async tools(server: string, signal?: AbortSignal) {
    const connection = await this.connection(server, signal);
    connection.tools = await collectPages(
      (cursor) =>
        connection.client.listTools(cursor ? { cursor } : undefined, {
          signal,
          timeout: connection.config.timeoutMs,
          cacheMode: "refresh",
        }),
      (page) => page.tools,
      signal,
    );
    return connection.tools
      .filter((tool) => this.toolAllowed(connection.config, tool.name))
      .map((tool) => ({
        ...tool,
        permissionName: mcpToolName(server, tool.name),
      }));
  }

  async call(
    server: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const connection = await this.connection(server, signal);
    if (!this.toolAllowed(connection.config, name))
      throw new Error("该 MCP 工具被服务 include/exclude 禁止");
    if (!connection.tools) await this.tools(server, signal);
    const tool = connection.tools?.find((tool) => tool.name === name);
    if (!tool) throw new Error("MCP 服务没有这个工具，请重新 discover");
    // The protocol exposes JSON values; the validator checks the narrower schema at runtime.
    const schema = tool.inputSchema as Parameters<
      AjvJsonSchemaValidator["getValidator"]
    >[0];
    const validation = this.validator.getValidator(schema)(args);
    if (!validation.valid)
      throw new Error(`MCP 参数不符合 inputSchema: ${validation.errorMessage}`);
    // Supplying the discovered definition also prevents the SDK's header-mismatch replay.
    return connection.client.callTool(
      { name, arguments: args },
      { signal, timeout: connection.config.timeoutMs, toolDefinition: tool },
    );
  }

  async resources(server: string, signal?: AbortSignal) {
    const { client, config } = await this.connection(server, signal);
    return {
      resources: await collectPages(
        (cursor) =>
          client.listResources(cursor ? { cursor } : undefined, {
            signal,
            timeout: config.timeoutMs,
          }),
        (page) => page.resources,
        signal,
      ),
    };
  }
  async resourceTemplates(server: string, signal?: AbortSignal) {
    const { client, config } = await this.connection(server, signal);
    return {
      resourceTemplates: await collectPages(
        (cursor) =>
          client.listResourceTemplates(cursor ? { cursor } : undefined, {
            signal,
            timeout: config.timeoutMs,
          }),
        (page) => page.resourceTemplates,
        signal,
      ),
    };
  }
  async readResource(server: string, uri: string, signal?: AbortSignal) {
    const { client, config } = await this.connection(server, signal);
    return client.readResource({ uri }, { signal, timeout: config.timeoutMs });
  }
  async prompts(server: string, signal?: AbortSignal) {
    const { client, config } = await this.connection(server, signal);
    return {
      prompts: await collectPages(
        (cursor) =>
          client.listPrompts(cursor ? { cursor } : undefined, {
            signal,
            timeout: config.timeoutMs,
          }),
        (page) => page.prompts,
        signal,
      ),
    };
  }
  async prompt(
    server: string,
    name: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ) {
    const { client, config } = await this.connection(server, signal);
    return client.getPrompt(
      { name, arguments: args },
      { signal, timeout: config.timeoutMs },
    );
  }

  async disconnect(server: string): Promise<void> {
    const pending = this.connections.get(server);
    this.connections.delete(server);
    const connection = await pending?.catch(() => undefined);
    await connection?.client.close();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.shutdown.abort();
    await Promise.all(
      [...this.connections.keys()].map((server) =>
        this.disconnect(server).catch((error) =>
          logger.warn(`[MCP] ${server} 关闭失败`, error),
        ),
      ),
    );
  }

  private async connection(
    server: string,
    signal?: AbortSignal,
  ): Promise<McpConnection> {
    if (this.closed) throw new Error("MCP 服务正在退出");
    signal?.throwIfAborted();
    const config = (await loadMcpConfig(this.file, this.cwd)).get(server);
    if (!config) {
      await this.disconnect(server);
      throw new Error(`MCP 服务未配置或已禁用: ${server}`);
    }
    let existing = this.connections.get(server);
    if (existing) {
      const connection = await existing;
      if (JSON.stringify(connection.config) === JSON.stringify(config))
        return connection;
      await this.disconnect(server);
      existing = undefined;
    }
    // Recheck after awaits so concurrent sessions share one server process.
    existing = this.connections.get(server);
    if (existing) return existing;
    const connecting = this.connect(server, config, signal).catch((error) => {
      if (this.connections.get(server) === connecting)
        this.connections.delete(server);
      throw error;
    });
    this.connections.set(server, connecting);
    return connecting;
  }

  private async connect(
    name: string,
    config: McpServerConfig,
    signal?: AbortSignal,
  ): Promise<McpConnection> {
    signal = signal
      ? AbortSignal.any([signal, this.shutdown.signal])
      : this.shutdown.signal;
    const client = new Client(
      { name: "mini-claw", version: "0.2.0" },
      { capabilities: {} },
    );
    let transport: Transport;
    if (config.transport === "stdio") {
      const env = Object.fromEntries(
        Object.entries(processEnvironment(config.env)).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const stdio = new StdioClientTransport({
        command: config.command!,
        args: config.args,
        cwd: config.cwd,
        env,
        stderr: "pipe",
      });
      // Drain stderr without putting server output (possibly secrets) in logs or protocol stdout.
      stdio.stderr?.on("data", () => {});
      transport = stdio;
    } else {
      const authenticatedFetch = (url: string | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        for (const [key, value] of Object.entries(config.headers ?? {}))
          headers.set(key, value);
        return fetch(url, { ...init, headers });
      };
      const options = {
        requestInit: { headers: config.headers },
        ...(config.transport === "sse"
          ? { eventSourceInit: { fetch: authenticatedFetch } }
          : {}),
      };
      transport =
        config.transport === "sse"
          ? new SSEClientTransport(new URL(config.url!), options)
          : new StreamableHTTPClientTransport(new URL(config.url!), options);
    }
    try {
      await client.connect(transport, { signal, timeout: config.timeoutMs });
      const connection = { client, config };
      client.onclose = () => {
        const pending = this.connections.get(name);
        void pending
          ?.then((current) => {
            if (
              current === connection &&
              this.connections.get(name) === pending
            )
              this.connections.delete(name);
          })
          .catch(() => undefined);
      };
      client.onerror = (error) =>
        logger.warn(`[MCP] ${name} 协议错误: ${error.message}`);
      if (this.closed) {
        await client.close();
        throw new Error("MCP 服务已退出");
      }
      return connection;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private toolAllowed(config: McpServerConfig, name: string): boolean {
    return (
      matchGlobs(config.include, name) && !matchGlobs(config.exclude, name)
    );
  }
}
