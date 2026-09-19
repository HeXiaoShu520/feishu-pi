import { createAgentSession, SessionManager, type AgentSession, DefaultResourceLoader, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { findEnvKeys, getModel, type ImageContent } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { FeishuPiConfig, FeishuPiEvent, FeishuPiPrompt, FeishuPiSession, FeishuPiTool } from "./types.ts";
import type { FeishuContext } from "../context/types.ts";
import { DEFAULT_BUILTIN_TOOLS, createToolRegistryAsync } from "../tools/registry.ts";
import { join, resolve, sep } from "node:path";
import { logger, colors } from "../utils/logger.ts";
import { createScheduleManagerTool } from "../schedule/tool.ts";
import type { GroupPolicy } from "../permission/policy.ts";

/** .agent/tools/ 里的脚本可在导出对象上附带 risk: "high"（强制走授权卡） */
type RiskyToolDefinition = ToolDefinition & { risk?: "high" };

/** pi 原始事件的最小结构（结构化类型，避免耦合 pi 内部的事件联合类型） */
export interface PiRawEvent {
  type: string;
  message?: { role: string; content: Array<{ type: string; text?: string }> };
  toolName?: string;
  args?: unknown;
  isError?: boolean;
}

/**
 * pi 原始事件 → 桥接事件映射（纯函数，供单测）。
 *
 * 关键点：assistant 正文除了监听 message_update（流式增量），**必须同时兜住
 * message_start / message_end**——pi 的 agent-loop 在模型一次性返回完整消息
 * （流里没有任何增量事件）时只发 start + end、不发 update，只监听 update 会导致
 * 这类"一次就出结果"的回复一个正文事件都收不到（卡片正文为空、小字却正常）。
 * 同一条消息 start/end 重复给出全文是安全的：桥接层按"新文本是旧文本前缀"去重，等长全文是空操作。
 */
export function mapPiEvent(event: PiRawEvent): FeishuPiEvent | undefined {
  const message = event.message;
  if (message && message.role === "assistant" && (event.type === "message_update" || event.type === "message_start" || event.type === "message_end")) {
    const text = message.content.filter((item) => item.type === "text").map((item) => item.text).join("");
    // message_start 的 partial 常为空内容：空文本不产生事件
    if (!text) return undefined;
    return { type: "assistant_text", text };
  }
  const toolName = "toolName" in event && typeof event.toolName === "string" ? event.toolName : "unknown";
  if (event.type === "tool_execution_start") return { type: "tool_started", toolName, args: "args" in event ? event.args : undefined };
  if (event.type === "tool_execution_update") return { type: "tool_updated", toolName };
  if (event.type === "tool_execution_end") return { type: "tool_finished", toolName, isError: "isError" in event && event.isError === true };
  return undefined;
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
    return this.raw.getSessionStats();
  }

  getModelName(): string {
    return this.raw.model?.id || "unknown";
  }

  subscribe(listener: (event: FeishuPiEvent) => void): () => void {
    return this.raw.subscribe((event) => {
      const mapped = mapPiEvent(event as unknown as PiRawEvent);
      if (mapped) listener(mapped);
    });
  }

  async prompt(input: FeishuPiPrompt): Promise<void> {
    const images: ImageContent[] = (input.images ?? []).map((image) => ({
      type: "image",
      data: Buffer.from(image.data).toString("base64"),
      mimeType: image.mimeType,
    }));
    // 脱敏后落会话：/login <provider> 体系下用户可能在聊天中提交凭证
    // （bitbucket app password、user token 等），进入 session jsonl 前统一遮蔽
    const text = input.text;
    await this.raw.prompt(text, images.length ? { images } : undefined);
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

/**
 * 系统提示（身份 + 行为规则）不再由代码拼装：统一放在 .agent/SYSTEM.md，
 * 由 Pi 的 ResourceLoader 自动发现并作为系统提示本体注入（agentDir = <仓库>/.agent）。
 * 加载结果由 printAvailableResources 打印，缺失会显式告警；改动该文件后需重启进程生效。
 */

/** 图片块被剔除后留在会话记录里的占位文本（原图另存于会话工作区的 images/，路径已写在消息文本里） */
export const IMAGE_OMITTED_PLACEHOLDER = "[图片已省略：base64 不写入会话文件，原图见消息中的 [图片] 路径]";

/**
 * 易失内容不落盘：包一层 SessionManager.appendMessage，写入会话文件前剔除两类内容——
 *   1) assistant 的思考过程：thinking 块与 reasoning_content/reasoningContent 字段（防膨胀、防内部推理外泄）；
 *   2) 图片：image 块（base64 内联，单张可达数百 KB）换成一行占位文本（防会话文件被图片撑爆）。
 *
 * 只影响持久化 jsonl，内存中的对话上下文不受影响（当前这轮模型仍按原样看到图片）；
 * 图片本体由传输层另存到会话工作区 images/ 并把路径写进消息文本，需要时可再用 read 工具取回。
 * 回放时 DeepSeek 按 compat 用空 reasoning_content 兜底，不会 400。
 */
function disableVolatilePersistence(sessionManager: {
  appendMessage: (message: Parameters<SessionManager["appendMessage"]>[0]) => string;
}): void {
  const original = sessionManager.appendMessage.bind(sessionManager);
  sessionManager.appendMessage = (message: Parameters<typeof original>[0]) => original(stripVolatileContent(message));
}

/** 深拷贝消息并剔除易失内容：content 里的 thinking 块（丢弃）与 image 块（换成占位文本）、顶层的 reasoning 字段。 */
export function stripVolatileContent<T>(message: T): T {
  if (message === null || message === undefined) return message;
  const clone = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
  if (Array.isArray(clone.content)) {
    clone.content = (clone.content as Array<Record<string, unknown>>)
      .filter((block) => block.type !== "thinking")
      .map((block) => (block.type === "image" ? { type: "text", text: IMAGE_OMITTED_PLACEHOLDER } : block));
  }
  delete clone.reasoning_content;
  delete clone.reasoningContent;
  return clone as T;
}

export class FeishuPiRuntime {
  private readonly config: FeishuPiConfig;
  private readonly tools: FeishuPiTool[];

  constructor(config: FeishuPiConfig, tools: FeishuPiTool[] = []) {
    this.config = config;
    this.tools = tools;
  }

  /**
   * 运行时切换模型：立即对新会话生效（已创建的会话沿用旧模型直到清空/重建）。
   * 持久化由调用方负责（transport 写 .env）。
   */
  setModelName(modelName: string): void {
    (this.config as { modelName: string }).modelName = modelName;
    logger.info(`[Runtime] 模型已切换为 ${colors.cyan}${modelName}${colors.reset}（新会话生效）`);
  }

  /** 基础 ResourceLoader：进程内只创建一次（Skills 上电加载，各会话复用同一实例）。 */
  private loadBaseLoaderOnce(): Promise<DefaultResourceLoader> {
    this.baseLoaderOnce ??= this.createBaseLoader();
    return this.baseLoaderOnce;
  }

  /** 创建并 reload 基础 ResourceLoader（必须 reload 后才能加载 skills）。 */
  private async createBaseLoader(): Promise<DefaultResourceLoader> {
    // 系统提示不在这里传：Pi 会自动发现 <agentDir>/SYSTEM.md（即 .agent/SYSTEM.md）作为系统提示本体，
    // 并把项目上下文（AGENTS.md 等）追加到系统提示末尾——全部由 Pi 原生加载，本工程不自写加载逻辑。
    const loader = new DefaultResourceLoader({
      cwd: this.config.cwd,
      agentDir: `${this.config.cwd}/.agent`,
      // 项目上下文白名单：只接受本工程目录内的文件。
      // Pi 默认会从 cwd 一路向上遍历到盘根收集 AGENTS.md / CLAUDE.md，且不经任何信任检查——
      // 也就是说任何祖先目录（含盘根）放一个 AGENTS.md 都能进入系统提示，构成外部可控的提示注入面。
      // 这里用 Pi 提供的过滤钩子做准入（加载仍是 Pi 原生行为，本工程只做筛选），丢弃项打日志，不静默。
      agentsFilesOverride: ({ agentsFiles }) => {
        const root = resolve(this.config.cwd) + sep;
        const kept = agentsFiles.filter((file) => resolve(file.path).startsWith(root));
        const dropped = agentsFiles.filter((file) => !resolve(file.path).startsWith(root));
        if (dropped.length > 0) {
          logger.warn(
            `[Runtime] 已忽略工程外的项目上下文文件: ${dropped.map((file) => file.path).join("、")}`,
          );
        }
        return { agentsFiles: kept };
      },
    });
    await loader.reload();
    return loader;
  }

  /**
   * 打印系统启动时可用的资源（管理员视角）
   * 用于启动日志，让用户知道加载了哪些 Skills 和 Tools
   */
  async printAvailableResources(): Promise<void> {
    const baseResourceLoader = await this.loadBaseLoaderOnce();
    const { skills } = baseResourceLoader.getSkills();

    if (skills.length > 0) {
      // 只报数量不逐个罗列：技能一多逐行打印就是刷屏，明细看 /stats 页面
      logger.info(`[Runtime] 已加载 ${colors.bright}${colors.magenta}${skills.length}${colors.reset} 个 Skills`);
    } else {
      logger.warn(`[Runtime] 未找到任何 Skills`);
    }

    // 系统提示来源：Pi 自动发现 <agentDir>/SYSTEM.md（agentDir 指向 <仓库>/.agent）。
    // 读不到时 Pi 会静默回落到内置的编码助手人格，助手身份/口吻将不受本仓库控制，故必须显式告警。
    const promptSource = baseResourceLoader.getSystemPromptSource();
    if (promptSource) {
      logger.info(`[Runtime] 系统提示来源 ${colors.cyan}${promptSource.path}${colors.reset}`);
    } else {
      logger.warn(`[Runtime] 未发现 .agent/SYSTEM.md —— 将使用 Pi 内置默认人格（编码助手），助手身份不受本仓库控制`);
    }

    // 项目上下文（AGENTS.md / CLAUDE.md 等）：Pi 自动发现并追加到系统提示末尾
    const { agentsFiles } = baseResourceLoader.getAgentsFiles();
    if (agentsFiles.length > 0) {
      logger.info(`[Runtime] 项目上下文 ${colors.cyan}${agentsFiles.map((file) => file.path).join("、")}${colors.reset}`);
    }

    // 自定义 Tools：Skills 之后加载，逐行打印（与 Skills 同款格式；描述超长截断）
    let customTools: FeishuPiTool[] = [];
    try {
      customTools = await this.loadCustomToolsOnce();
    } catch (error) {
      logger.warn("[Runtime] 自定义 Tools 加载失败（不影响启动，下个会话重试）:", error);
    }
    if (customTools.length > 0) {
      logger.info(`[Runtime] 已加载 ${colors.bright}${colors.cyan}${customTools.length}${colors.reset} 个 Tools`);
    } else {
      logger.info(`[Runtime] 未找到自定义 Tools（.agent/tools/ 为空）`);
    }

    // 当前模型的名字与解析后的使用配置（协议/地址/上下文/视觉/思维链/计价/密钥变量）
    try {
      const model = this.resolveModel();
      // 目录外模型的接入方式说明并入名字后，不单独打日志（每次建会话都不刷模型行）
      const typed = model as { inheritedFrom?: string; customApi?: string };
      const sourceNote = typed.inheritedFrom
        ? `（未收录，已继承 ${typed.inheritedFrom} 目录语义）`
        : typed.customApi
          ? `（目录外，按 ${typed.customApi === "anthropic-messages" ? "Anthropic" : "OpenAI"} 兼容协议接入）`
          : "";
      const inputDesc = model.input?.includes("image") ? "文本+图片" : "文本";
      const keyEnv = findEnvKeys(this.config.modelProvider as never, process.env as Record<string, string>)?.[0]
        ?? `${this.config.modelProvider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
      const thinking = (model.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat;
      logger.info(
        `[Runtime] 当前模型 ${colors.cyan}${model.provider}/${model.id}${colors.reset}${sourceNote}: ` +
          `地址 ${model.baseUrl ?? "官方默认"} · 上下文 ${model.contextWindow ?? "?"} · 输出上限 ${model.maxTokens ?? "?"} · 输入 ${inputDesc} · ${thinking ? `思维链 ${thinking} · ` : ""}档位 ${this.config.thinkingLevel} · 定价 ${model.cost?.input ?? 0}/${model.cost?.output ?? 0} per M · 密钥注入 ${keyEnv}`,
      );
    } catch (error) {
      logger.warn("[Runtime] 当前模型属性读取失败:", error);
    }

    // 打印内置工具列表
    logger.info(`[Runtime] 内置工具: ${colors.gray}${DEFAULT_BUILTIN_TOOLS.join(", ")}${colors.reset}`);
  }

  /** 自定义工具全集：进程内只扫描/导入一次，各会话复用同一份定义（失败可重试） */
  private customToolsOnce?: Promise<FeishuPiTool[]>;
  /** 基础资源加载器（Skills 等）：进程内只创建/reload 一次，各会话复用 */
  private baseLoaderOnce?: Promise<DefaultResourceLoader>;

  private loadCustomToolsOnce(): Promise<FeishuPiTool[]> {
    this.customToolsOnce ??= createToolRegistryAsync(this.config.cwd)
      .then((defs) =>
        defs.map((def) => ({
          name: def.name,
          label: def.label ?? def.name,
          description: def.description,
          parameters: def.parameters,
          execute: def.execute.bind(def) as FeishuPiTool["execute"],
          risk: (def as RiskyToolDefinition).risk,
        })),
      )
      .catch((error) => {
        this.customToolsOnce = undefined; // 失败不缓存，下个会话重试
        throw error;
      });
    return this.customToolsOnce;
  }

  /** 上电预加载：权限策略 + Skills + 自定义工具在启动时全部就绪，首条消息零初始化日志。 */
  async preload(): Promise<void> {
    await Promise.all([
      this.loadBaseLoaderOnce(),
      this.loadCustomToolsOnce(),
      this.config.permissionPolicy.preload(),
    ]);
  }

  /**
   * 解析会话模型：内置目录命中直接用（可覆写 base_url）；未命中按同协议构造自定义模型——
   * 任意 OpenAI/Anthropic 兼容端点（中转站、DeepSeek 等）凭 base_url 即可接入，不要求目录收录。
   */
  private resolveModel(): NonNullable<ReturnType<typeof getModel>> {
    const { modelProvider: provider, modelName: name, modelBaseUrl: baseUrl } = this.config;
    const known = getModel(provider as never, name as never);
    // 精确 id 未收录 → 继承同供应商目录条目的协议语义（thinkingFormat、reasoning_content
    // 回传、窗口与计价），只替换 id/name。匹配规则：
    //   1) 尾段同名（deepseek-v4.1-flash → deepseek-v4-flash）；
    //   2) 模型名以供应商名开头（deepseek 开头 → deepseek 目录），兜底取该组第一条。
    // 供应商整个不在目录时才走最后的通用 OpenAI/Anthropic 兼容分支
    let template = known;
    let inheritedFrom: string | undefined;
    if (!template) {
      const family = getBuiltinModels(provider as never);
      const suffix = name.split("-").pop() ?? "";
      const match =
        family.find((m) => m.id.endsWith(`-${suffix}`)) ??
        (name.toLowerCase().startsWith(provider.toLowerCase()) ? family[0] : undefined);
      if (match) {
        // DeepSeek 官方确认：旧模型名已由 DeepSeek-V4.1-Flash 提供服务，且该模型支持图像理解——
        // 继承语义时补上图片输入声明，让用户发的图可以直接传给模型
        template = {
          ...match,
          id: name,
          name,
          input: [...new Set([...(match.input ?? []), "image" as const])],
        };
        inheritedFrom = match.id;
      }
    }
    if (template) {
      const withBase = baseUrl ? { ...template, baseUrl } : template;
      // 继承来的模型在对象上带 inheritedFrom 标记，由启动属性行合并展示（不单独刷一行日志）
      return { ...withBase, inheritedFrom } as NonNullable<ReturnType<typeof getModel>> & { inheritedFrom?: string };
    }
    const anthropicCompatible = provider === "anthropic";
    // 完全不在目录的模型带 customApi 标记，由启动属性行合并展示（不单独刷一行日志）
    return {
      id: name,
      name,
      api: anthropicCompatible ? "anthropic-messages" : "openai-completions",
      provider,
      baseUrl: baseUrl || (anthropicCompatible ? "https://api.anthropic.com" : "https://api.openai.com/v1"),
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
      customApi: anthropicCompatible ? "anthropic-messages" : "openai-completions",
    } as NonNullable<ReturnType<typeof getModel>> & { customApi?: string };
  }

  async createSession(sessionFile: string | undefined, userId: string, context?: FeishuContext): Promise<FeishuPiSession> {
    // 设置 API key 到对应厂商的环境变量
    const apiKey = process.env.FEISHU_PI_MODEL_API_KEY;
    if (!apiKey) {
      throw new Error("FEISHU_PI_MODEL_API_KEY is required");
    }
    // Pi 自带各厂商密钥环境变量映射表：按 provider 查出变量名后注入（覆盖目录内全部厂商）
    const envName = findEnvKeys(this.config.modelProvider as never, process.env as Record<string, string>)?.[0]
      ?? `${this.config.modelProvider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
    process.env[envName] = apiKey;

    // 判定所属身份组；策略在每次工具调用时按文件 mtime 缓存重编译——
    // 修改 permissions.json 对已驻留会话即时生效，无需 /new 或重启
    const groups = await this.config.permissionPolicy.groupsFor(userId, context?.userName);
    const groupPolicyFor = (): Promise<GroupPolicy> => this.config.permissionPolicy.forGroups(groups);
    const displayName = context?.userName || userId;
    logger.info(`[Runtime] 用户身份: ${colors.cyan}${displayName}${colors.reset}(${colors.gray}${userId}${colors.reset}) -> ${colors.yellow}${groups.join(", ") || "(无组)"}${colors.reset}`);

    // 一个会话一个文件夹：新会话的 jsonl 落在会话专属目录；续聊传入同目录，
    // 供 Pi 内部 /new、分支等操作在正确位置建新文件
    // 会话目录：由会话注册表给出——一次会话一个目录，Pi 会话文件（jsonl）
    // 与用户图片/附件/OCR 过程文件同居其中；/new 换代后这里自然拿到新目录
    const convDir = await this.config.sessions.dirFor(context?.conversationId ?? "default");
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, convDir, this.config.cwd)
      : SessionManager.create(this.config.cwd, convDir);
    // 易失内容不落盘：写入会话文件前剔除 thinking 块与顶层 reasoning 字段，并把 image 块换成占位文本。
    // 内存中的对话上下文不受影响；回放时 DeepSeek 按 compat 用空 reasoning_content 兜底，不会 400
    disableVolatilePersistence(sessionManager);
    const model = this.resolveModel();

    // 技能/自定义工具均上电加载一次（进程内缓存复用，修改后需重启生效）
    const baseResourceLoader = await this.loadBaseLoaderOnce();
    const customTools = await this.loadCustomToolsOnce();
    // 项目内置交互工具（ask_user_question 等）：随会话注册，并把调用者身份注入参数，
    // 工具执行时经 params._caller 拿到提问对象与会话（见 bindCallers）
    // identityBash（可选）：同名覆盖内置 bash，spawn 前按会话用户注入 CLI 凭证环境变量
    const identityBashTool = this.config.identityBash?.(userId, context);
    const sessionTools = [
      ...bindCallers(this.tools, { openId: userId, chatId: context?.chatId ?? "" }),
      ...customTools,
      ...(identityBashTool ? [identityBashTool] : []),
      // 定时任务管理工具：直连进程内 ScheduleService；对所有会话注入，
      // 可见性由组策略 Tools(schedule_manager) 决定（任务以创建者身份与权限执行）
      ...(this.config.scheduleService
        ? [createScheduleManagerTool(this.config.scheduleService, {
            chatId: context?.chatId ?? "",
            createdBy: userId,
          })]
        : []),
    ];

    // 自定义工具可标记 risk: "high"：标记后不走策略放行，仍走授权卡
    const riskyTools = new Set(
      customTools.filter((tool) => tool.risk === "high").map((tool) => tool.name),
    );

    // 内置工具对所有会话统一注册：read / bash / write / edit。
    // 能不能用、用在哪，完全由 permissions.json 的组策略决定——
    // 未配置 Write 规则的调用一律拦截（fail-safe），不按身份砍工具。
    const builtinNames = ["read", "bash", "write", "edit"];

    const { session } = await createAgentSession({
      cwd: this.config.cwd,
      sessionManager,
      model,
      // 思考档位：默认 high（DeepSeek 官方默认）；pi 默认 off 会显式发 thinking:disabled 关思考
      thinkingLevel: this.config.thinkingLevel,
      tools: builtinNames,
      customTools: sessionTools,
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
    const toolGuard = this.config.toolGuard;
    const chatId = context?.chatId;
    session.agent.beforeToolCall = async (ctx, signal) => {
      // 每次调用重新取已编译策略（内部有 mtime 缓存）：permissions.json 改动即时生效
      const groupPolicy = await groupPolicyFor();
      if (ctx.toolCall.name === "read") {
        const target = extractReadPath(ctx.args);
        if (target !== undefined) {
          // 第 0 层 deny 规则：先于可读范围判定，对所有人（含管理员）生效
          const denyHit = groupPolicy.deniedPath(target);
          if (denyHit) {
            logger.warn(`[Runtime] 读取已被 deny 规则拦截: ${target}（命中 ${denyHit}）`);
            return { block: true, reason: `⛔ 该路径已被权限策略禁止访问（命中 deny 规则 ${denyHit}）` };
          }
          const allowed = groupPolicy.readAllowed(target);
          if (!allowed) {
            return { block: true, reason: "⛔ 该路径不在你的可读范围内" };
          }
        }
        return undefined;
      }

      // 自定义工具：先检查 tools 可见范围
      // （ask_user_question 是内置交互工具，只向提问对象本人发卡，所有人可用）
      if (
        ctx.toolCall.name !== "bash" &&
        ctx.toolCall.name !== "write" &&
        ctx.toolCall.name !== "edit" &&
        ctx.toolCall.name !== "ask_user_question"
      ) {
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
              requesterOpenId: userId,
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

/**
 * 项目内置工具绑定调用者身份：派发时在参数里注入 _caller（openId/chatId），
 * 供 ask_user_question 这类交互工具定位"向谁提问、在哪个会话发卡"。
 * _caller 不在工具 schema 中，模型不可见、不可伪造（由会话创建时的身份决定）。
 */
function bindCallers(tools: FeishuPiTool[], caller: { openId: string; chatId: string }): FeishuPiTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: (...args: Parameters<FeishuPiTool["execute"]>) => {
      const [toolCallId, params, signal, onUpdate] = args;
      const record = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
      return tool.execute(toolCallId, { ...record, _caller: caller } as never, signal, onUpdate);
    },
  }));
}
