import { createAgentSession, SessionManager, type AgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { getModel, type ImageContent } from "@earendil-works/pi-ai/compat";
import type { FeishuPiConfig, FeishuPiEvent, FeishuPiPrompt, FeishuPiSession, FeishuPiTool } from "./types.ts";
import type { FeishuContext } from "../context/types.ts";
import { DEFAULT_BUILTIN_TOOLS, createToolRegistryAsync } from "../tools/registry.ts";
import { join } from "node:path";
import { logger, colors } from "../utils/logger.ts";
import { matchSkillRead } from "../stats/skill-usage-store.ts";
import type { SkillUsageStore } from "../stats/skill-usage-store.ts";
import type { GroupPolicy } from "../permission/policy.ts";

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
    return this.raw.getSessionStats();
  }

  getModelName(): string {
    return this.raw.model?.id || "unknown";
  }

  /** 当前上下文占用（token 数 / 窗口 / 百分比），用于统计小字的 ctx 显示。 */
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined {
    return (this.raw as { getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined }).getContextUsage?.();
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
    // abort 返回 Promise，这里不等待（调用方只负责触发中断）
    void this.raw.abort();
  }
}

/**
 * 技能文档对所有用户开放，不做权限过滤（技能是说明书而非能力，
 * 能力边界在工具注册层的组过滤与 ToolGuard）。资源加载直接使用 Pi 的基础实现。
 */

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
      logger.info(`[Runtime] 已加载 ${colors.bright}${colors.magenta}${skills.length}${colors.reset} 个 Skills（对所有人开放）:`);
      skills.forEach((skill) => {
        logger.info(`  ${colors.magenta}✆${colors.reset} ${colors.cyan}${skill.name}${colors.reset}: ${skill.description}`);
      });
    } else {
      logger.warn(`[Runtime] 未找到任何 Skills`);
    }
  
    // 打印内置工具列表
    logger.info(`[Runtime] 内置工具(按组策略注册): ${colors.gray}${DEFAULT_BUILTIN_TOOLS.join(", ")}${colors.reset}`);
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

    // 判定所属身份组（owner 负责人 / user 用户），并取该组的已编译策略
    const groups = await this.config.permissionPolicy.groupsFor(userId, context?.userName);
    const groupPolicy: GroupPolicy = await this.config.permissionPolicy.forGroups(groups);
    logger.info(`[Runtime] 用户身份: ${colors.cyan}${userId}${colors.reset} -> ${colors.yellow}${groups.join(", ") || "(无组)"}${colors.reset}`);

    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, this.config.sessionDir, this.config.cwd)
      : SessionManager.create(this.config.cwd, this.config.sessionDir);
    const model = getModel(this.config.modelProvider as never, this.config.modelName as never);
    if (!model) throw new Error(`Model not found: ${this.config.modelProvider}/${this.config.modelName}`);

    // 技能全量加载（不做权限过滤）；自定义工具从 .agent/tools/ 加载
    const baseResourceLoader = await this.createBaseLoader();

    // 加载 .agent/tools/ 目录下的自定义工具（Python + TS/JS 脚本）
    const customToolDefs = await createToolRegistryAsync(this.config.cwd);
    let customTools: FeishuPiTool[] = customToolDefs.map((def) => ({
      name: def.name,
      label: def.label ?? def.name,
      description: def.description,
      parameters: def.parameters,
      execute: def.execute.bind(def) as FeishuPiTool["execute"],
      risk: (def as any).risk,
    }));

    // 自定义工具可标记 risk: "high"：标记后不走策略放行，仍走授权卡
    const riskyTools = new Set(
      customTools.filter((tool) => (tool as any).risk === "high").map((tool) => tool.name),
    );

    // 内置工具：负责人全量注册；用户组注册 bash + read（范围与命令约束在漏斗按组策略执行）。
    const builtinNames: string[] = groups.includes("admin")
      ? ["read", "bash", "write", "edit"]
      : ["bash", "read"];

    const { session } = await createAgentSession({
      cwd: this.config.cwd,
      sessionManager,
      model: this.config.modelBaseUrl ? { ...model, baseUrl: this.config.modelBaseUrl } : model,
      tools: builtinNames,
      customTools,
      resourceLoader: baseResourceLoader,
    });

    // 立即落盘会话头：Pi 默认在首个 message_end 才创建 session 文件，
    // 提前写入 session_info 条目让 sessionFile 马上可用，
    // 会话映射因此能在"开始响应之前"就持久化，中断/崩溃也不丢
    if (!session.sessionFile) {
      const name = `feishu:${context?.userName || userId}:${new Date().toISOString()}`;
      sessionManager.appendSessionInfo(name);
    }

    // 注入 beforeToolCall 钩子（统一策略过滤层）：
    //   read → 所属组可读范围判定（范围外拦截不弹卡，范围内放行）
    //   bash / write / edit / 自定义工具 → ToolGuard 按所属组策略判定（名单外交授权卡）
    //   自定义工具另由 tools 字段控制可用性
    // 放行后记录技能使用事件。统计失败只告警不阻塞。
    const toolGuard = this.config.toolGuard;
    const usageStore = this.config.skillUsageStore;
    const chatId = context?.chatId;
    session.agent.beforeToolCall = async (ctx, signal) => {
      if (ctx.toolCall.name === "read") {
        const target = extractReadPath(ctx.args);
        if (target !== undefined) {
          const allowed = groupPolicy.readAllowed(target);
          if (!allowed) {
            return { block: true, reason: "⛔ 该路径不在你的可读范围内" };
          }
        }
        // 范围内的技能读取：记录使用事件（被拦截的不算使用），随后放行
        if (usageStore) {
          const skill = matchSkillRead(ctx.toolCall.name, ctx.args, this.config.cwd, `${this.config.cwd}/.agent`);
          if (skill) {
            await usageStore.record({ ts: Date.now(), user: userId, skill, chatId }).catch((error) => {
              logger.warn(`[Runtime] 技能使用记录失败: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        }
        return undefined;
      }

      // 自定义工具：先检查 tools 可见范围
      if (ctx.toolCall.name !== "bash" && ctx.toolCall.name !== "write" && ctx.toolCall.name !== "edit") {
        if (!groupPolicy.toolsAllowed(ctx.toolCall.name)) {
          return { block: true, reason: `⛔ 工具 \"${ctx.toolCall.name}\" 不在你的可用范围内` };
        }
      }
      if (this.config.toolGuard) {
        try {
          const guardResult = await this.config.toolGuard(
            groupPolicy,
            {
              toolName: ctx.toolCall.name,
              args: ctx.args,
              chatId,
              risky: riskyTools.has(ctx.toolCall.name),
            },
            signal,
          );
          if (guardResult) return guardResult;
        } catch (error) {
          // Guard 自身异常按默认拒绝处理
          const detail = error instanceof Error ? error.message : String(error);
          logger.warn(`[Runtime] ToolGuard 异常，按拒绝处理: ${detail}`);
          return { block: true, reason: `工具 ${ctx.toolCall.name} 审核异常：${detail}` };
        }
      }
      return undefined;
    };

    return new SessionWrapper(session);
  }
}

/** 从 read 调用参数中提取路径。 */
function extractReadPath(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file_path"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return undefined;
}
