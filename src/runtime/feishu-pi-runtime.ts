import { createAgentSession, SessionManager, type AgentSession, DefaultResourceLoader, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { findEnvKeys, getModel, type ImageContent } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { FeishuPiConfig, FeishuPiEvent, FeishuPiPrompt, FeishuPiSession, FeishuPiTool } from "./types.ts";
import type { FeishuContext } from "../context/types.ts";
import { DEFAULT_BUILTIN_TOOLS, createToolRegistryAsync } from "../tools/registry.ts";
import { join } from "node:path";
import { logger, colors } from "../utils/logger.ts";
import { conversationDir } from "../utils/session-paths.ts";
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
 * 精简模式的配套规则（注入系统提示）：卡片只保留"最后一次工具调用之后"的正文作为最终答复，
 * 因此要求模型每次工具调用后输出完整独立的结论——这是使用侧保证，否则终态不可读。
 */
const NL = String.fromCharCode(10);
const FINAL_REPLY_RULE = [
  "【最终答复规则】每轮对话的最后一次输出（最后一次工具调用之后）必须是语义完整、可独立阅读的最终答复——无论过程信息以何种方式展示，用户都以这段答复为准。",
  "要求：",
  "1. 直接给出结论或答案，不使用「如上」「承接上文」等依赖中间过程的表述；",
  "2. 若本轮调用过工具，用简短篇幅总结过程：做了什么、关键结果如何，让用户不看过程也能掌握全貌；",
  "3. 有未完成的事项或过程中发现的问题，一并列出。",
  "未调用工具的普通问答无需套用以上结构，正常回答即可。",
].join(NL);

/**
 * 密钥安全规则（注入系统提示，模型侧约束）：
 * 不主动读取/输出密钥凭据；确需返回敏感值时必须加星号遮蔽。
 * bash 指令另有执行前过滤兜底（src/guard/tool-guard.ts）。
 */
const SECRET_RULE = [
  "【密钥安全规则】不要读取、引用或输出 .env、密钥/证书/私钥/凭据类敏感文件（如 *.key、*.pem、id_rsa、credentials 等）的内容。",
  "如果某些时候任务确实需要返回密钥、令牌之类的敏感值，返回时一定要用星号遮蔽（只保留前几位，其余用 * 代替），不允许明文输出。",
].join(NL);

/**
 * 内置默认人格：PERSONA.md 未配置时生效（配置后由其替换此段）。
 * 没有它，系统提示开头就是安全规则，模型不知道自己是谁、以什么口吻说话。
 */
const DEFAULT_PERSONA = [
  "你是部署在飞书里的智能助手，通过飞书与用户对话，可以使用工具（bash、读写文件、lark-cli 等）帮助用户完成查询与操作。",
  "默认使用中文交流，用户使用其他语言时跟随用户语言；回答先给结论、简洁直接，必要时分点。",
  "不确定的信息如实说明，不编造；操作受权限策略与授权卡约束，按流程执行即可，无需向用户复述这些约束。",
].join(NL);

/**
 * 长期记忆规则（注入系统提示）：memory 工具读写 data/memory/MEMORY.md（团队共享）。
 * 会话历史 7 天即清，跨会话的事实/偏好/约定靠它留存。
 */
const MEMORY_RULE = [
  "【长期记忆】工具 memory 是团队的持久记忆（所有人可见）。当用户交代需要长期记住的事实、偏好或约定，或对话中沉淀出值得保留的结论时，调用 memory(action=\"append\", text=一句话要点) 记下；当任务可能与既往背景相关时，先 memory(action=\"read\") 回忆，避免重复询问。",
  "记忆要经常维护：条目重复、过时或 read 时提示超限时，用 rewrite 用去重合并后的精简版整体覆盖（拒绝空内容）。记忆对团队全员可见，禁止写入密码等敏感信息。",
].join(NL);

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
    const loader = new DefaultResourceLoader({
      cwd: this.config.cwd,
      agentDir: `${this.config.cwd}/.agent`,
      systemPrompt: [this.config.systemPrompt ?? DEFAULT_PERSONA, MEMORY_RULE.trim(), SECRET_RULE.trim(), FINAL_REPLY_RULE.trim()].filter(Boolean).join(NL),
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
    // 会话目录：优先用 workspaceFor 提供的会话工作区（jsonl 与图片/附件同处）；未配置回退传统布局
    const convDir = this.config.workspaceFor
      ? await this.config.workspaceFor(context?.conversationId ?? "default")
      : conversationDir(this.config.sessionDir, context?.conversationId ?? "default");
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, convDir, this.config.cwd)
      : SessionManager.create(this.config.cwd, convDir);
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
