import { createAgentSession, SessionManager, type AgentSession, DefaultResourceLoader, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { getModel, type ImageContent } from "@earendil-works/pi-ai/compat";
import type { FeishuPiConfig, FeishuPiEvent, FeishuPiPrompt, FeishuPiSession, FeishuPiTool, UserRole } from "./types.ts";
import { createToolRegistryAsync, DEFAULT_BUILTIN_TOOLS } from "../tools/registry.ts";
import { logger, colors } from "../utils/logger.ts";
import { createRestrictedReadTool } from "../tools/restricted-read.ts";

class SessionWrapper implements FeishuPiSession {
  readonly sessionFile?: string;
  private readonly raw: AgentSession;

  constructor(session: AgentSession) {
    this.raw = session;
    this.sessionFile = session.sessionFile;
  }

  subscribe(listener: (event: FeishuPiEvent) => void): () => void {
    return this.raw.subscribe((event) => {
      if (event.type === "message_update" && event.message.role === "assistant") {
        const text = event.message.content.filter((item) => item.type === "text").map((item) => item.text).join("");
        listener({ type: "assistant_text", text });
        return;
      }
      if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
        const toolName = "toolName" in event && typeof event.toolName === "string" ? event.toolName : "unknown";
        if (event.type === "tool_execution_start") listener({ type: "tool_started", toolName });
        if (event.type === "tool_execution_update") listener({ type: "tool_updated", toolName });
        if (event.type === "tool_execution_end") listener({ type: "tool_finished", toolName, isError: "isError" in event && event.isError === true });
      }
    });
  }

  async prompt(input: FeishuPiPrompt): Promise<void> {
    const images: ImageContent[] = (input.images ?? []).map((image) => ({
      type: "image",
      data: Buffer.from(image.data).toString("base64"),
      mimeType: image.mimeType,
    }));
    await this.raw.prompt(input.text, images.length ? { images } : undefined);
  }

  async waitForIdle(): Promise<void> {
    await this.raw.waitForIdle();
  }

  abort(): void {
    if (typeof (this.raw as any).abort === "function") {
      (this.raw as any).abort();
    }
  }
}

/**
 * 根据权限过滤 Skills 的 ResourceLoader
 */
class PermissionFilteredResourceLoader implements ResourceLoader {
  private base: DefaultResourceLoader;
  private userRole: UserRole;

  constructor(base: DefaultResourceLoader, userRole: UserRole) {
    this.base = base;
    this.userRole = userRole;
  }

  getExtensions() {
    return this.base.getExtensions();
  }

  getSkills() {
    const { skills, diagnostics } = this.base.getSkills();
    const filtered = skills.filter((skill) => {
      const permission = (skill as any).permission || "default";
      if (permission === "default") return true;
      if (permission === "team") return this.userRole === "team" || this.userRole === "admin";
      if (permission === "admin") return this.userRole === "admin";
      return false;
    });
    return { skills: filtered, diagnostics };
  }

  getPrompts() {
    return this.base.getPrompts();
  }

  getThemes() {
    return this.base.getThemes();
  }

  getAgentsFiles() {
    return this.base.getAgentsFiles();
  }

  getSystemPrompt() {
    return this.base.getSystemPrompt();
  }

  getSystemPromptSource() {
    return this.base.getSystemPromptSource();
  }

  getAppendSystemPrompt() {
    return this.base.getAppendSystemPrompt();
  }

  getAppendSystemPromptSources() {
    return this.base.getAppendSystemPromptSources();
  }

  extendResources(paths: any) {
    return this.base.extendResources(paths);
  }

  async reload(options?: any) {
    return this.base.reload(options);
  }
}

export class FeishuPiRuntime {
  private readonly config: FeishuPiConfig;
  private readonly tools: FeishuPiTool[];

  constructor(config: FeishuPiConfig, tools: FeishuPiTool[] = []) {
    this.config = config;
    this.tools = tools;
  }

  /**
   * 打印系统启动时可用的资源（管理员视角）
   * 用于启动日志，让用户知道加载了哪些 Skills 和 Tools
   */
  async printAvailableResources(): Promise<void> {
    // 加载 Skills（管理员视角，显示所有）
    const baseResourceLoader = new DefaultResourceLoader({
      cwd: this.config.cwd,
      agentDir: `${this.config.cwd}/.agent`,
      systemPrompt: this.config.systemPrompt,
    });

    // 必须先 reload 才能加载 skills
    await baseResourceLoader.reload();

    const { skills } = baseResourceLoader.getSkills();

    if (skills.length > 0) {
      logger.info(`[Runtime] 已加载 ${colors.bright}${colors.magenta}${skills.length}${colors.reset} 个 Skills:`);
      skills.forEach((skill) => {
        const permission = (skill as any).permission || "default";
        logger.info(`  ${colors.magenta}✦${colors.reset} ${colors.cyan}${skill.name}${colors.reset}: ${skill.description} ${colors.gray}[${permission}]${colors.reset}`);
      });
    } else {
      logger.warn(`[Runtime] 未找到任何 Skills`);
    }

    // 加载自定义 Tools（从 .agent/tools/）
    const customTools = await createToolRegistryAsync(this.config.cwd, this.tools);
    if (customTools.length > 0) {
      logger.info(`[Runtime] 已加载 ${colors.bright}${colors.green}${customTools.length}${colors.reset} 个自定义 Tools:`);
      customTools.forEach((tool) => {
        const permission = (tool as any).permission || "default";
        logger.info(`  ${colors.green}⚙${colors.reset} ${colors.cyan}${tool.name}${colors.reset}: ${tool.description} ${colors.gray}[${permission}]${colors.reset}`);
      });
    } else {
      logger.info(`[Runtime] 未找到自定义 Tools`);
    }

    // 打印内置工具列表
    logger.info(`[Runtime] 内置工具: ${colors.gray}${DEFAULT_BUILTIN_TOOLS.join(", ")}${colors.reset}`);
  }

  async createSession(sessionFile: string | undefined, userId: string): Promise<FeishuPiSession> {
    // 设置 API key 到对应厂商的环境变量
    const apiKey = process.env.FEISHU_PI_MODEL_API_KEY;
    if (!apiKey) {
      throw new Error("FEISHU_PI_MODEL_API_KEY is required");
    }
    if (this.config.modelProvider === "anthropic") {
      process.env.ANTHROPIC_API_KEY = apiKey;
    } else if (this.config.modelProvider === "openai") {
      process.env.OPENAI_API_KEY = apiKey;
    }

    // 判断用户角色
    const userRole = this.getUserRole(userId);
    logger.info(`[Runtime] 用户角色: ${colors.cyan}${userId}${colors.reset} -> ${colors.yellow}${userRole}${colors.reset}`);

    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, this.config.sessionDir, this.config.cwd)
      : SessionManager.create(this.config.cwd, this.config.sessionDir);
    const model = getModel(this.config.modelProvider as never, this.config.modelName as never);
    if (!model) throw new Error(`Model not found: ${this.config.modelProvider}/${this.config.modelName}`);

    // 创建基础 ResourceLoader
    const baseResourceLoader = new DefaultResourceLoader({
      cwd: this.config.cwd,
      agentDir: `${this.config.cwd}/.agent`,
      systemPrompt: this.config.systemPrompt,
    });

    // 必须先 reload 才能加载 skills
    await baseResourceLoader.reload();

    // 包装成权限过滤的 ResourceLoader
    const resourceLoader = new PermissionFilteredResourceLoader(baseResourceLoader, userRole);

    // 获取用户可用的 skills（不打印，只用于加载）
    const { skills } = resourceLoader.getSkills();

    // 从 .agent/tools/ 加载用户自定义工具
    const allCustomTools = await createToolRegistryAsync(this.config.cwd, this.tools);
    let customTools = allCustomTools.filter((tool) => {
      const permission = (tool as any).permission || "default";
      if (permission === "default") return true;
      if (permission === "team") return userRole === "team" || userRole === "admin";
      if (permission === "admin") return userRole === "admin";
      return false;
    });

    // 非管理员：添加受限的 read 工具（只能读 skills）
    const agentDir = `${this.config.cwd}/.agent`;
    if (userRole !== "admin") {
      customTools = [createRestrictedReadTool(this.config.cwd, agentDir), ...customTools];
    }

    // 根据角色选择内置工具
    let builtinTools: string[];
    if (userRole === "admin") {
      builtinTools = this.config.builtinTools ?? [...DEFAULT_BUILTIN_TOOLS];
    } else {
      // 非管理员：无内置工具（read 已通过 customTools 提供）
      builtinTools = [];
    }

    const { session } = await createAgentSession({
      cwd: this.config.cwd,
      sessionManager,
      model: this.config.modelBaseUrl ? { ...model, baseUrl: this.config.modelBaseUrl } : model,
      tools: builtinTools,
      customTools,
      resourceLoader,
    });
    return new SessionWrapper(session);
  }

  private getUserRole(userId: string): UserRole {
    if (userId === this.config.adminId) return "admin";
    if (this.config.teamMemberIds.includes(userId)) return "team";
    return "default";
  }
}
