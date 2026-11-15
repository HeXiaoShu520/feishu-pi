import { createProfileUpdateTool } from "../memory/tool.ts";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { biliDecisionPrompt, parseBiliDecision } from "../bilibili/decision.ts";
import { createAgentSession, SessionManager, type AgentSession, DefaultResourceLoader, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { findEnvKeys, getModel, type ImageContent } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { deriveModelProvider } from "../config.ts";
import type { FeishuPiConfig, FeishuPiEvent, FeishuPiPrompt, FeishuPiSession, FeishuPiTool, FeishuContext } from "./types.ts";
import { DEFAULT_BUILTIN_TOOLS } from "../tools/registry.ts";
import { AgentResources } from "../resources/catalog.ts";
import { logger, colors } from "../utils/logger.ts";
import { createScheduleManagerTool } from "../schedule/tool.ts";
import type { ToolPolicy } from "../permission/policy.ts";
import { conversationIdentity } from "../conversation/presence.ts";

/** .agent/tools/ 里的脚本可在导出对象上附带 risk: "high"（强制走授权卡） */
type RiskyToolDefinition = ToolDefinition & { risk?: "high" };

/** pi 原始事件的最小结构（结构化类型，避免耦合 pi 内部的事件联合类型） */
export interface PiRawEvent {
  type: string;
  message?: { role: string; content: Array<{ type: string; text?: string }> };
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  result?: unknown;
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
  if (event.type === "tool_execution_end") return { type: "tool_finished", toolName, isError: "isError" in event && event.isError === true, ...(event.result !== undefined ? { result: event.result } : {}) };
  return undefined;
}

function addTurnReference<T>(message: T, reference: string): T {
  if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") return message;
  const add = (text: string): string => `${reference}\n\n本轮用户消息：\n${text}`;
  const original = message as { content?: unknown };
  if (typeof original.content === "string") return { ...original, content: add(original.content) } as T;
  if (!Array.isArray(original.content)) return message;
  let seenText = false;
  const content = original.content.map((block: unknown) => {
    if (seenText || !block || typeof block !== "object") return block;
    const item = block as { type?: unknown; text?: unknown };
    if (item.type !== "text" || typeof item.text !== "string") return block;
    seenText = true;
    return { ...item, text: add(item.text) };
  });
  return { ...original, content } as T;
}

export class SessionWrapper implements FeishuPiSession {
  private readonly raw: AgentSession;
  private readonly roleContext?: string;
  private readonly stickers?: () => Promise<string>;
  private readonly onActivity?: () => void;
  private readonly recall?: (query: string) => Promise<string>;
  private activeReference = "";
  private readonly onProfileTurn?: (text: string | undefined) => void;

  constructor(session: AgentSession, options: {
    roleContext?: string;
    stickers?: () => Promise<string>;
    onActivity?: () => void;
    recall?: (query: string) => Promise<string>;
    onProfileTurn?: (text: string | undefined) => void;
  } = {}) {
    this.raw = session;
    this.roleContext = options.roleContext;
    this.stickers = options.stickers;
    this.onActivity = options.onActivity;
    this.recall = options.recall;
    this.onProfileTurn = options.onProfileTurn;
    if (session.agent) {
      const previous = session.agent.transformContext;
      session.agent.transformContext = async (messages, signal) => {
        const result = previous ? await previous(messages, signal) : messages;
        let lastUser = -1;
        for (let i = result.length - 1; i >= 0; i--) {
          if (result[i].role === "user") { lastUser = i; break; }
        }
        return this.activeReference && lastUser >= 0
          ? result.map((message, index) => index === lastUser ? addTurnReference(message, this.activeReference) : message)
          : result;
      };
    }
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
    this.onActivity?.();
    const images: ImageContent[] = (input.images ?? []).map((image) => ({
      type: "image",
      data: Buffer.from(image.data).toString("base64"),
      mimeType: image.mimeType,
    }));
    // 每轮请求时注入：对方是谁、你记得的事、最近发过哪些表情。
    // 这些只进请求，不写会话历史，避免记忆块在历史里反复累积。
    const [recalled, stickers] = await Promise.all([
      this.recall ? this.recall(input.memoryText ?? input.text).catch((error) => { logger.warn("[Memory] 读取失败:", error instanceof Error ? error.message : error); return ""; }) : "",
      this.stickers ? this.stickers().catch(() => "") : "",
    ]);
    const reference = [
      this.roleContext,
      input.turnContext,
      recalled,
      stickers && `这个聊天里最近发过的表情（名称和标签，供参考，不代表你看过原图）：\n${stickers}`,
    ].filter(Boolean).join("\n\n");
    this.activeReference = reference;
    try {
      this.onProfileTurn?.(input.memoryText);
      await this.raw.prompt(input.text, images.length ? { images } : undefined);
    } finally {
      this.onActivity?.();
      this.activeReference = "";
      this.onProfileTurn?.(undefined);
    }
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

/**
 * 关闭回复 emoji 时追加到系统提示的规则（FEISHU_PI_REPLY_EMOJI=0，默认）。
 * 写在代码里而不是 SYSTEM.md：这是按环境变量开关的约束，静态人格文件无法表达开关。
 * 发送前另有 stripEmoji 兜底，防模型偶发不听话。
 */
const REPLY_EMOJI_OFF_RULE =
  "文字回复中不要使用 emoji 表情符号（😀🙂😅 这类）或颜文字，情绪用文字表达；表情包图片消息（sticker_send）不受此限。";

/**
 * 易失内容不落盘：包一层 SessionManager.appendMessage，写入会话文件前剔除——
 * assistant 的思考过程（thinking 块与 reasoning_content/reasoningContent 字段，防膨胀、防内部推理外泄）。
 *
 * 注意 image 块必须保留：Pi 1.5.0 起 AgentSession 在每次请求前用 SessionManager 投影
 * （buildSessionProjection，见 _installAgentRequestProjection）覆盖请求消息，
 * 写盘时剥掉的图当轮就到不了模型——「先落盘再投影」使内存副本不再是请求来源。
 * 图片 base64 因此留在会话 jsonl 里（单张数百 KB；work_space 不入库，data-cleaner 管保留期），
 * 图片本体另存于会话工作区 images/（路径写在消息文本里）。
 * 回放时 DeepSeek 按 compat 用空 reasoning_content 兜底，不会 400。
 */
function disableVolatilePersistence(sessionManager: {
  appendMessage: (message: Parameters<SessionManager["appendMessage"]>[0]) => string;
}): void {
  const original = sessionManager.appendMessage.bind(sessionManager);
  sessionManager.appendMessage = (message: Parameters<typeof original>[0]) => original(stripVolatileContent(message));
}

/** 深拷贝消息并剔除易失内容：content 里的 thinking 块（丢弃）与顶层的 reasoning 字段；image 块保留（理由见上）。 */
export function stripVolatileContent<T>(message: T): T {
  if (message === null || message === undefined) return message;
  const clone = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
  if (Array.isArray(clone.content)) {
    clone.content = (clone.content as Array<Record<string, unknown>>).filter((block) => block.type !== "thinking");
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
    this.resources = new AgentResources(config.cwd, {
      appendSystemPrompt: config.replyEmoji ? [] : [REPLY_EMOJI_OFF_RULE],
    });
    this.tools = tools;
  }

  /** 装配轻量长期记忆（main 在运行时创建完成后注入）。 */
  setMemory(memory: NonNullable<FeishuPiConfig["memory"]>): void {
    this.config.memory = memory;
  }

  /** 读取当前人格提示；主动发言等辅助生成需要和聊天保持同一套人设。 */
  async getSystemPrompt(): Promise<string> {
    return (await this.loadBaseLoaderOnce()).getSystemPrompt() ?? "";
  }

  /** 辅助生成复用当前模型，但不读取会话、凭据资料或任何人的私聊记忆。 */
  async completeText(system: string, user: string, maxTokens = 1600): Promise<string> {
    const response = await completeSimple(this.resolveModel(), {
      systemPrompt: system,
      messages: [{ role: "user", content: user, timestamp: Date.now() }],
    }, { apiKey: process.env.FEISHU_PI_MODEL_API_KEY, signal: AbortSignal.timeout(60_000), maxTokens });
    if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || "辅助模型调用失败");
    return response.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  }

  async biliDecision(stage: "keywords" | "video" | "reply" | "share", data: unknown, signal: AbortSignal): Promise<unknown> {
    const prompt = biliDecisionPrompt(stage, data);
    const persona = (await this.loadBaseLoaderOnce()).getSystemPrompt() ?? "";
    const response = await completeSimple(this.resolveModel(), { systemPrompt: `${persona}\n\n${prompt.system}`, messages: [{ role: "user", content: prompt.text, timestamp: Date.now() }] }, {
      apiKey: process.env.FEISHU_PI_MODEL_API_KEY, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]), maxTokens: 500,
    });
    if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || "B 站决策模型调用失败");
    return parseBiliDecision(stage, response.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
  }

  setModelName(modelName: string): void {
    this.config.modelName = modelName;
    this.config.modelProvider = deriveModelProvider(modelName);
    logger.info(`[Runtime] 模型已切换为 ${colors.cyan}${modelName}${colors.reset}（新会话生效）`);
  }

  /** 基础 ResourceLoader：进程内只创建一次（Skills 上电加载，各会话复用同一实例）。 */
  private loadBaseLoaderOnce(): Promise<DefaultResourceLoader> {
    this.baseLoaderOnce ??= this.createBaseLoader();
    return this.baseLoaderOnce;
  }

  private async createBaseLoader(): Promise<DefaultResourceLoader> {
    return (await this.resources.load()).loader;
  }

  /**
   * 打印系统启动时可用的资源（个人能力视角）
   * 用于启动日志，让用户知道加载了哪些 Skills 和 Tools
   */
  async printAvailableResources(): Promise<void> {
    logger.info(`[Runtime] 个人工具: ${this.tools.map((tool) => tool.name).join(", ")}, background_task, schedule_manager`);
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
  private readonly resources: AgentResources;

  private loadCustomToolsOnce(): Promise<FeishuPiTool[]> {
    this.customToolsOnce ??= this.resources.load()
      .then(({ tools: defs }) =>
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
    const isOwner = !!this.config.ownerOpenId && userId === this.config.ownerOpenId;
    if (!isOwner && (!context?.chatMode || context.userOpenId !== userId || !/^ou_[A-Za-z0-9_-]+$/.test(userId))) throw new Error("访客身份或聊天类型无效");
    // 设置 API key 到对应厂商的环境变量
    const apiKey = process.env.FEISHU_PI_MODEL_API_KEY;
    if (!apiKey) {
      throw new Error("FEISHU_PI_MODEL_API_KEY is required");
    }
    // Pi 自带各厂商密钥环境变量映射表：按 provider 查出变量名后注入（覆盖目录内全部厂商）
    const envName = findEnvKeys(this.config.modelProvider as never, process.env as Record<string, string>)?.[0]
      ?? `${this.config.modelProvider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
    process.env[envName] = apiKey;

    // 取得个人权限策略；策略在每次工具调用时按文件 mtime 缓存重编译——
    // 修改 permissions.json 对已驻留会话即时生效，无需 /new 或重启
    const policyFor = async (): Promise<ToolPolicy> => this.config.permissionPolicy.current();
    const displayName = context?.userName || userId;
    logger.info(`[Runtime] ${isOwner ? "本人" : "访客"}: ${colors.cyan}${displayName}${colors.reset}(${colors.gray}${userId}${colors.reset})`);

    // 一个会话一个文件夹：新会话的 jsonl 落在会话专属目录；续聊传入同目录，
    // 供 Pi 内部 /new、分支等操作在正确位置建新文件
    // 会话目录：由会话注册表给出——一次会话一个目录，Pi 会话文件（jsonl）
    // 与用户图片/附件同居其中；/new 换代后这里自然拿到新目录
    const convDir = await this.config.sessions.dirFor(context?.conversationId ?? "default", context?.userOpenId);
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, convDir, this.config.cwd)
      : SessionManager.create(this.config.cwd, convDir);
    // 易失内容不落盘：写入会话文件前剔除 thinking 块与顶层 reasoning 字段；image 块必须保留（理由见 disableVolatilePersistence）。
    // 回放时 DeepSeek 按 compat 用空 reasoning_content 兜底，不会 400
    disableVolatilePersistence(sessionManager);
    const model = this.resolveModel();

    // 技能/自定义工具均上电加载一次（进程内缓存复用，修改后需重启生效）
    const baseResourceLoader = await this.loadBaseLoaderOnce();
    const customTools = await this.loadCustomToolsOnce();
    // 项目内置交互工具（ask_user_question 等）：随会话注册，并把调用者身份注入参数，
    // 工具执行时经 params._caller 拿到提问对象与会话（见 bindCallers）
    // identityBash（可选）：同名覆盖内置 bash，spawn 前按会话用户注入 CLI 凭证环境变量
    const identityBashTool = isOwner ? this.config.identityBash?.(userId, context) : undefined;
    const ownerSessionTools = isOwner ? (this.config.sessionTools?.({ openId: userId, chatId: context?.chatId ?? "", cwd: convDir }) ?? []) : [];
    let activeProfileUserText: string | undefined;
    const profileMemory = this.config.memory;
    const profileTool = context && profileMemory?.updateProfile ? createProfileUpdateTool(
      { updateProfile: profileMemory.updateProfile.bind(profileMemory) }, context.userOpenId,
      { chatId: context.chatId, chatMode: context.chatMode ?? "group", threadId: context.threadId },
      () => activeProfileUserText) : undefined;
    const otherSessionTools = isOwner ? [
      ...bindCallers(this.tools, { openId: userId, chatId: context?.chatId ?? "" }),
      ...customTools.filter(tool => !ownerSessionTools.some(other => other.name === tool.name)),
      ...ownerSessionTools,
      ...(identityBashTool ? [identityBashTool] : []),
      // 定时任务管理工具：直连进程内 ScheduleService；对所有会话注入，
      // 可见性由个人策略 Tools(schedule_manager) 决定（任务以创建者身份与权限执行）
      ...(this.config.scheduleService
        ? [createScheduleManagerTool(this.config.scheduleService, {
            chatId: context?.chatId ?? "",
            createdBy: userId,
          })]
        : []),
    ] : (this.config.guestTools?.({ openId: userId, chatId: context?.chatId ?? "" }) ?? []).filter(tool => tool.name === "sticker_search" || tool.name === "sticker_send");

    const sessionTools = [...otherSessionTools.filter(tool => tool.name !== "profile_update"), ...(profileTool ? [profileTool] : [])];

    // 自定义工具可标记 risk: "high"：标记后不走策略放行，仍走授权卡
    const riskyTools = new Set(
      sessionTools.filter((tool) => (tool as RiskyToolDefinition).risk === "high").map((tool) => tool.name),
    );

    // 内置工具对所有会话统一注册：read / bash / write / edit。
    // 能不能用、用在哪，完全由 permissions.json 的个人策略决定——
    // 未配置 Write 规则的调用一律拦截（fail-safe），不按身份砍工具。
    // Pi 1.4's tools option is an allowlist for custom tools too.
    const builtinNames = [...new Set([...(isOwner ? ["read", "bash", "write", "edit"] : []), ...sessionTools.map(tool => tool.name)])];

    const { session } = await createAgentSession({
      cwd: this.config.cwd,
      sessionManager,
      model,
      // 思考档位：默认 off（关闭思考，pi 显式发 thinking:disabled）；FEISHU_PI_THINKING_LEVEL 可开
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

    // 注入 beforeToolCall 钩子：所有外部能力都走同一门禁。
    // deny 硬拒绝；ask 才调用模型；allow 直通；其余拒绝。
    const chatId = context?.chatId;
    session.agent.beforeToolCall = async (ctx, signal) => {
      if (!isOwner && ctx.toolCall.name !== "sticker_search" && ctx.toolCall.name !== "sticker_send"
        && !(profileTool && ctx.toolCall.name === "profile_update")) return { block: true, reason: "普通用户不能使用本机或管理员账户工具" };
      // 每次调用重新取已编译策略（内部有 mtime 缓存）：permissions.json 改动即时生效
      const toolPolicy = await policyFor();
      if (this.config.toolGuard) {
        try {
          const guardResult = await this.config.toolGuard(
            toolPolicy,
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
          // 权限放行后再查单轮预算：超限的 block 理由回给模型，引导其停止调用直接作答
          const limitReason = this.config.toolCallLimiter?.check(ctx.toolCall.name, chatId);
          if (limitReason) return { block: true, reason: limitReason };
          return undefined;
        } catch (error) {
          // Guard 自身异常按默认拒绝处理
          const detail = error instanceof Error ? error.message : String(error);
          logger.warn(`[Runtime] ToolGuard 异常，按拒绝处理: ${detail}`);
          return { block: true, reason: `工具 ${ctx.toolCall.name} 审核异常：${detail}` };
        }
      }
      return { block: true, reason: "权限门禁未装配，默认拒绝工具调用" };
    };

    // Identity comes from trusted caller context. Memory is scoped to this exact chat/person/topic.
    const roleContext = conversationIdentity(isOwner, context?.chatMode);
    const recall = this.config.memory && context
      ? (query: string) => this.config.memory!.recall(context.userOpenId, {
          chatId: context.chatId, chatMode: context.chatMode ?? "group", threadId: context.threadId,
        }, query)
      : undefined;
    return new SessionWrapper(session, {
      onProfileTurn: text => { activeProfileUserText = text; },
      roleContext,
      stickers: context?.chatId && this.config.stickerHistory ? () => this.config.stickerHistory!(context.chatId) : undefined,
      onActivity: context?.chatId && this.config.onChatActivity ? () => this.config.onChatActivity!(context.chatId) : undefined,
      recall,
    });
  }
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
