import { join } from "node:path";
import { BrowserService } from "../browser/service.ts";
import { createBrowserTool } from "../browser/tool.ts";
import { BackgroundTaskService, type BackgroundTask } from "../tasks/service.ts";
import { createBackgroundTaskTool } from "../tasks/tool.ts";
import { McpService } from "../mcp/service.ts";
import { createMcpTool } from "../mcp/tool.ts";
import type { IdentityShellLease } from "../runtime/identity-bash.ts";
import type { FeishuPiTool } from "../runtime/types.ts";

export interface AssistantServiceOptions {
  cwd: string; dataDir: string; sessionsRoot: string; ownerOpenId: string; browserChannel?: string;
  notifyTask: (task: BackgroundTask) => Promise<void>;
  openShell: (caller: { openId: string; chatId: string }) => Promise<IdentityShellLease>;
}

/** Composition only. Services know neither Pi sessions nor Feishu cards. */
export class AssistantServices {
  readonly browser: BrowserService;
  readonly tasks: BackgroundTaskService;
  readonly mcp: McpService;
  private readonly options: AssistantServiceOptions;
  constructor(options: AssistantServiceOptions) {
    this.options = options;
    this.browser = new BrowserService({ cwd: options.cwd, dataDir: options.dataDir, browser: options.browserChannel });
    this.tasks = new BackgroundTaskService({ dataDir: options.dataDir, notify: options.notifyTask });
    this.mcp = new McpService({ file: join(options.cwd, ".agent", "mcp.json"), cwd: options.cwd });
  }
  tools(): FeishuPiTool[] { return [createBrowserTool(this.browser), createMcpTool(this.mcp)]; }
  sessionTools(caller: { openId: string; chatId: string; cwd: string }): FeishuPiTool[] {
    return [createBackgroundTaskTool(this.tasks, { cwd: caller.cwd, chatId: caller.chatId, openLease: () => this.options.openShell(caller) })];
  }
  async start(): Promise<void> { await this.tasks.initialize(); }
  async close(): Promise<void> { await Promise.all([this.tasks.close(), this.browser.close(), this.mcp.close()]); }
}
