import { createAgentSession, SessionManager, type AgentSession, DefaultResourceLoader, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { getModel, type ImageContent } from "@earendil-works/pi-ai/compat";
import type { FeishuPiConfig, FeishuPiEvent, FeishuPiPrompt, FeishuPiSession, FeishuPiTool, UserRole } from "./types.ts";
import type { FeishuContext } from "../context/types.ts";
import { createToolRegistryAsync, DEFAULT_BUILTIN_TOOLS } from "../tools/registry.ts";
import { logger, colors } from "../utils/logger.ts";
import { createRestrictedReadTool } from "../tools/restricted-read.ts";

/**
 * 判断某个 skill/tool 的 permission 标记是否对指定角色可见。
 * 约定：default 所有人可见、team 需团队成员或管理员、admin 仅管理员。
 */
function hasPermission(permission: string | undefined, userRole: UserRole): boolean {
  const level = permission || "default";
  if (level === "default") return true;
  if (level === "team") return userRole === "team" || userRole === "admin";
  if (level === "admin") return userRole === "admin";
  return false;
}

class SessionWrapper implements FeishuPiSession {
  private readonly raw: AgentSession;

  constructor(session: AgentSession) {
    this.raw = session;
  }

  /** 实时读取 Pi 的 sessionFile——新会话首次持久化后才会出现，不能在构造时快照。 */
  get sessionFile(): string | undefined {
    return this.raw.sessionFile;
  }

  getStats() {
    return (this.raw as any).getSessionStats?.();
  }

  getModelName(): string {
    return this.raw.model?.id || "unknown";
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
        if (event.type === "tool_execution_start") listener({ type: "tool_started", toolName, args: "args" in event ? event.args : undefined });
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
    return { skills: skills.filter((skill) => hasPermission((skill as any).permission, this.userRole)), diagnostics };
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
  /**
   * 运行时切换模型：立即对新会话生效（已创建的会话沿用旧模型直到清空/重建）。
   * 持久化由调用方负责（transport 写 .env）。
   */
  setModelName(modelName: string): void {
    (this.config as { modelName: string }).modelName = modelName;
    logger.info(`[Runtime] 模型已切换为 ${colors.cyan}${modelName}${colors.reset}（新会话生效）`);
  }

  /** 创建并 reload 基础 ResourceLoader（必须 reload 后才能加载 skills）。 */
  private async createBaseLoader(): Promise<DefaultResourceLoader> {
    const loader = new DefaultResourceLoader({
      cwd: this.config.cwd,
      agentDir: `${this.config.cwd}/.agent`,
      systemPrompt: this.config.systemPrompt,
    });
    await loader.reload();
    return loader;
  }

  /**
   * 打印系统启动时可用的资源（管理员视角）
   * 用于启动日志，让用户知道加载了哪些 Skills 和 Tools
   */
  async printAvailableResources(): Promise<void> {
    const baseResourceLoader = await this.createBaseLoader();
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

  async createSession(sessionFile: string | undefined, userId: string, context?: FeishuContext): Promise<FeishuPiSession> {
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
    const userRole = this.getUserRole(userId, context);
    logger.info(`[Runtime] 用户角色: ${colors.cyan}${userId}${colors.reset} -> ${colors.yellow}${userRole}${colors.reset}`);

    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, this.config.sessionDir, this.config.cwd)
      : SessionManager.create(this.config.cwd, this.config.sessionDir);
    const model = getModel(this.config.modelProvider as never, this.config.modelName as never);
    if (!model) throw new Error(`Model not found: ${this.config.modelProvider}/${this.config.modelName}`);

    // 包装成权限过滤的 ResourceLoader，再按角色过滤自定义工具
    const baseResourceLoader = await this.createBaseLoader();
    const resourceLoader = new PermissionFilteredResourceLoader(baseResourceLoader, userRole);

    // 从 .agent/tools/ 加载用户自定义工具，按角色过滤
    const allCustomTools = await createToolRegistryAsync(this.config.cwd, this.tools);
    let customTools = allCustomTools.filter((tool) => hasPermission((tool as any).permission, userRole));

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

    // 立即落盘会话头：Pi 默认在首个 message_end 才创建 session 文件，
    // 提前写入 session_info 条目让 sessionFile 马上可用，
    // 会话映射因此能在"开始响应之前"就持久化，中断/崩溃也不丢
    if (!session.sessionFile) {
      const name = `feishu:${context?.userName || userId}:${new Date().toISOString()}`;
      sessionManager.appendSessionInfo(name);
    }

    // 注入工具调用 Guard：每次工具执行前经过白名单 / 大模型审核 / 管理员授权卡
    const toolGuard = this.config.toolGuard;
    if (toolGuard) {
      const chatId = context?.chatId;
      session.agent.beforeToolCall = async (ctx, signal) => {
        try {
          return await toolGuard({ toolName: ctx.toolCall.name, args: ctx.args, chatId }, signal);
        } catch (error) {
          // Guard 自身异常按默认拒绝处理
          const detail = error instanceof Error ? error.message : String(error);
          logger.warn(`[Runtime] ToolGuard 异常，按拒绝处理: ${detail}`);
          return { block: true, reason: `工具 ${ctx.toolCall.name} 审核异常：${detail}` };
        }
      };
    }

    return new SessionWrapper(session);
  }

  private getUserRole(userId: string, context?: FeishuContext): UserRole {
    // 管理员判断
    if (userId === this.config.adminId) return "admin";

    // 团队成员判断（支持 Open ID / 姓名 / 邮箱）
    if (this.config.teamMemberIdentifiers.length > 0) {
      // 直接匹配 Open ID
      if (this.config.teamMemberIdentifiers.includes(userId)) {
        return "team";
      }

      // 匹配姓名
      if (context?.userName && this.config.teamMemberIdentifiers.includes(context.userName)) {
        return "team";
      }

      // TODO: 如果需要支持邮箱匹配，需要在 context 中添加 email 字段
    }

    return "default";
  }
}
