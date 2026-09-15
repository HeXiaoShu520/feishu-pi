import { createAgentSession, SessionManager, type AgentSession, DefaultResourceLoader, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getModel, type ImageContent } from "@earendil-works/pi-ai/compat";
import type { FeishuPiConfig, FeishuPiEvent, FeishuPiPrompt, FeishuPiSession, FeishuPiTool } from "./types.ts";
import type { FeishuContext } from "../context/types.ts";
import { DEFAULT_BUILTIN_TOOLS, createToolRegistryAsync } from "../tools/registry.ts";
import { join } from "node:path";
import { logger, colors } from "../utils/logger.ts";
import { redactSecrets } from "../utils/redact.ts";
import { conversationDir } from "../utils/session-paths.ts";
import { matchSkillRead } from "../stats/skill-usage-store.ts";
import type { SkillUsageStore } from "../stats/skill-usage-store.ts";
import type { GroupPolicy } from "../permission/policy.ts";

/** .agent/tools/ 里的脚本可在导出对象上附带 risk: "high"（强制走授权卡） */
type RiskyToolDefinition = ToolDefinition & { risk?: "high" };

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
    // 脱敏后落会话：/login <provider> 体系下用户可能在聊天中提交凭证
    // （bitbucket app password、user token 等），进入 session jsonl 前统一遮蔽
    const text = redactSecrets(input.text);
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
      systemPrompt: [this.config.systemPrompt, SECRET_RULE.trim(), FINAL_REPLY_RULE.trim()].filter(Boolean).join(NL),
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
      logger.info(`[Runtime] 已加载 ${colors.bright}${colors.magenta}${skills.length}${colors.reset} 个 Skills（对所有人开放）:`);
      skills.forEach((skill) => {
        // 每行（含名字）最多显示 90 个可见字符，超长描述截断
        const head = `  ✆ ${skill.name}: `;
        const desc = String(skill.description ?? "").replace(/\s+/g, " ").trim();
        const maxDesc = Math.max(0, 90 - head.length);
        const shown = desc.length > maxDesc ? `${desc.slice(0, maxDesc)}…` : desc;
        logger.info(`  ${colors.magenta}✆${colors.reset} ${colors.cyan}${skill.name}${colors.reset}: ${shown}`);
      });
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
      logger.info(`[Runtime] 已加载 ${colors.bright}${colors.cyan}${customTools.length}${colors.reset} 个 Tools（.agent/tools，随组策略注册）:`);
      customTools.forEach((tool) => {
        const head = `  ⚙ ${tool.name}: `;
        const desc = String(tool.description ?? "").replace(/\s+/g, " ").trim();
        const maxDesc = Math.max(0, 90 - head.length);
        const shown = desc.length > maxDesc ? `${desc.slice(0, maxDesc)}…` : desc;
        logger.info(`  ${colors.cyan}⚙${colors.reset} ${colors.cyan}${tool.name}${colors.reset}: ${shown}`);
      });
    } else {
      logger.info(`[Runtime] 未找到自定义 Tools（.agent/tools/ 为空）`);
    }

    // 打印内置工具列表
    logger.info(`[Runtime] 内置工具(按组策略注册): ${colors.gray}${DEFAULT_BUILTIN_TOOLS.join(", ")}${colors.reset}`);
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

    // 判定所属身份组（admin 管理员组 / 其余自定义组），并取该组的已编译策略
    const groups = await this.config.permissionPolicy.groupsFor(userId, context?.userName);
    const groupPolicy: GroupPolicy = await this.config.permissionPolicy.forGroups(groups);
    const displayName = context?.userName || userId;
    logger.info(`[Runtime] 用户身份: ${colors.cyan}${displayName}${colors.reset}(${colors.gray}${userId}${colors.reset}) -> ${colors.yellow}${groups.join(", ") || "(无组)"}${colors.reset}`);

    // 一个会话一个文件夹：新会话的 jsonl 落在会话专属目录；续聊传入同目录，
    // 供 Pi 内部 /new、分支等操作在正确位置建新文件
    const convDir = conversationDir(this.config.sessionDir, context?.conversationId ?? "default");
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, convDir, this.config.cwd)
      : SessionManager.create(this.config.cwd, convDir);
    const model = getModel(this.config.modelProvider as never, this.config.modelName as never);
    if (!model) throw new Error(`Model not found: ${this.config.modelProvider}/${this.config.modelName}`);

    // 技能/自定义工具均上电加载一次（进程内缓存复用，修改后需重启生效）
    const baseResourceLoader = await this.loadBaseLoaderOnce();
    const customTools = await this.loadCustomToolsOnce();
    // 项目内置交互工具（ask_user_question 等）：随会话注册，并把调用者身份注入参数，
    // 工具执行时经 params._caller 拿到提问对象与会话（见 bindCallers）
    // identityBash（可选）：同名覆盖内置 bash，spawn 前按会话用户注入 CLI 凭证环境变量
    const identityBashTool = this.config.identityBash?.(userId);
    const sessionTools = [
      ...bindCallers(this.tools, { openId: userId, chatId: context?.chatId ?? "" }),
      ...customTools,
      ...(identityBashTool ? [identityBashTool] : []),
    ];

    // 自定义工具可标记 risk: "high"：标记后不走策略放行，仍走授权卡
    const riskyTools = new Set(
      customTools.filter((tool) => tool.risk === "high").map((tool) => tool.name),
    );

    // 内置工具：read 人人都有（阅读技能/文档，可读范围由策略限制）；
    // bash 亦注册（能否执行哪些命令由组名单决定）；write/edit 仅 admin 组。
    const builtinNames: string[] = groups.includes("admin")
      ? ["read", "bash", "write", "edit"]
      : ["read", "bash"];

    const { session } = await createAgentSession({
      cwd: this.config.cwd,
      sessionManager,
      model: this.config.modelBaseUrl ? { ...model, baseUrl: this.config.modelBaseUrl } : model,
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
    // 放行后记录技能使用事件。统计失败只告警不阻塞。
    const toolGuard = this.config.toolGuard;
    const usageStore = this.config.skillUsageStore;
    const chatId = context?.chatId;
    session.agent.beforeToolCall = async (ctx, signal) => {
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
