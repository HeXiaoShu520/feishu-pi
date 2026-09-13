/**
 * 机器人指令（/model /help /new /stop /detail /perm）。
 *
 * 设计：每个指令一个 CommandHandler 实现，依赖一律构造注入（会话操作、策略查询、
 * 模型信息提供器），指令本身不读全局配置、不持有可变状态——便于单测与复用。
 * 注册表按注册顺序匹配，bridge 在此基础上追加 /detail /perm /login 等注入式指令。
 */
import type { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuInboundMessage } from "./types.ts";
import type { PermissionPolicy } from "../permission/policy.ts";
import { logger } from "../utils/logger.ts";

/** 指令处理器接口：match 判定是否命中，execute 返回要发送的卡片 */
export interface CommandHandler {
  /** 检测消息是否为此指令 */
  match(text: string): boolean;
  /** 执行指令，返回卡片 JSON；返回 null 表示不发送回复 */
  execute(message: FeishuInboundMessage, client: Client): Promise<CommandResult | null>;
}

export interface CommandResult {
  /** 卡片 JSON */
  card: object;
  /** 卡片发出后回调（含 message_id），用于需要稍后原地更新卡片的场景（如 /login 的授权轮询结果） */
  afterSend?: (messageId?: string) => void;
}

/** /model 指令展示与拉取模型列表所需的运行时信息（提供器返回实时值，支持热切换后仍正确）。 */
export interface ModelInfo {
  /** 模型中转站 Base URL（未配置则 /model 提示先配置） */
  baseUrl?: string;
  /** 当前使用的模型名 */
  modelName: string;
  /** 拉取模型列表用的 API Key（可为空：部分中转站允许无密钥访问） */
  apiKey: string;
}

/** 构建一张只含单段 Markdown 的 CardKit 2.0 卡片（指令回复的标准形态）。 */
export function markdownCard(content: string): object {
  return {
    schema: "2.0",
    body: { elements: [{ tag: "markdown", content }] },
  };
}

/** 错误提示卡（❌ 前缀）。 */
function errorCard(message: string): object {
  return markdownCard(`❌ ${message}`);
}

/**
 * /model - 显示可用模型列表，点击按钮切换（实际切换由卡片回调处理）。
 * 模型信息经构造注入的提供器获取，指令不直接读 .env / process.env。
 */
export class ModelCommand implements CommandHandler {
  private readonly getModelInfo: () => ModelInfo;

  constructor(getModelInfo: () => ModelInfo) {
    this.getModelInfo = getModelInfo;
  }

  match(text: string): boolean {
    return text.trim() === "/model";
  }

  async execute(message: FeishuInboundMessage, _client: Client): Promise<CommandResult | null> {
    try {
      const info = this.getModelInfo();

      // 必须配置中转站 URL
      if (!info.baseUrl) {
        return { card: errorCard("未配置模型中转站 URL\n\n请在 .env 中配置:\nFEISHU_PI_MODEL_BASE_URL=https://your-proxy.com/v1") };
      }

      let models: Array<{ model_id: string; name: string }> = [];
      let successBaseURL = "";

      try {
        // 生成候选 /models URL 列表并按顺序尝试（参考 cc-switch 的智能候选逻辑）
        const candidates = this.buildModelUrlCandidates(info.baseUrl);
        logger.info(`[ModelCommand] 尝试 ${candidates.length} 个候选端点`);

        let lastError: string | undefined;
        for (const modelsUrl of candidates) {
          try {
            logger.info(`[ModelCommand] 尝试: ${modelsUrl}`);

            // 直接用 fetch，不通过 OpenAI SDK（支持无密钥访问）
            const headers: Record<string, string> = {};
            if (info.apiKey) headers["Authorization"] = `Bearer ${info.apiKey}`;
            const response = await fetch(modelsUrl, { headers });

            if (!response.ok) {
              // 404/405 说明该端点不存在，继续尝试下一个候选
              if (response.status === 404 || response.status === 405) {
                lastError = `HTTP ${response.status}`;
                continue;
              }
              throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }

            const data = await response.json() as { data?: Array<{ id: string }> };
            models = (data.data || []).map((m) => ({ model_id: m.id, name: m.id }));
            if (models.length > 0) {
              successBaseURL = modelsUrl.replace(/\/models$/, "");
              logger.info(`[ModelCommand] 成功从 ${modelsUrl} 获取 ${models.length} 个模型`);
              break;
            }
          } catch (err) {
            // fetch 抛出的异常可能带 HTTP status（如端点不存在），404/405 换下一个候选
            const status = (err as { status?: number } | undefined)?.status;
            if (status === 404 || status === 405) {
              lastError = `HTTP ${status}`;
              continue;
            }
            throw err;
          }
        }

        if (models.length === 0) {
          return { card: errorCard(`所有候选端点均失败\n\n最后错误: ${lastError || "未知"}`) };
        }
      } catch (err) {
        logger.error(`[ModelCommand] 从中转站获取模型列表失败:`, err);
        return { card: errorCard(`获取模型列表失败\n\n${err instanceof Error ? err.message : String(err)}`) };
      }

      // 构建 CardKit 2.0 卡片：说明文字 + 每个模型一个按钮
      const elements = [
        {
          tag: "markdown",
          content: message.context.isAdmin
            ? `**可用模型列表**\n\n中转站: ${successBaseURL}\n当前: ${info.modelName}\n\n请选择要切换的模型：`
            : `**可用模型列表**\n\n中转站: ${successBaseURL}\n当前: ${info.modelName}\n\n⚠️ 仅管理员可切换模型`,
        },
        ...models.map((model) => ({
          tag: "button",
          width: "fill",
          text: { tag: "plain_text", content: model.name },
          type: "default",
          behaviors: [{ type: "callback", value: { action: "switch_model", model_id: model.model_id } }],
        })),
      ];

      return {
        card: {
          schema: "2.0",
          header: { title: { tag: "plain_text", content: "可用模型列表" } },
          config: { update_multi: true },  // 允许多人看到相同的更新
          body: { elements },
        },
      };
    } catch (err) {
      logger.error("[ModelCommand] 执行失败:", err);
      return { card: errorCard("获取模型列表时出错") };
    }
  }

  /**
   * 生成模型列表端点的候选 URL（参考 cc-switch 实现）
   *
   * 策略：
   * 1. baseURL 拼 /v1/models
   * 2. 若 baseURL 已以 /v{N} 结尾，改拼 /models
   * 3. 若命中已知兼容子路径（/anthropic、/api/anthropic 等），剥离后再拼
   */
  private buildModelUrlCandidates(baseUrl: string): string[] {
    const KNOWN_COMPAT_SUFFIXES = [
      "/api/claudecode",
      "/api/anthropic",
      "/apps/anthropic",
      "/api/coding",
      "/claudecode",
      "/anthropic",
      "/step_plan",
      "/coding",
      "/claude",
    ];

    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    const candidates: string[] = [];

    // 检查是否以版本段结尾（/v1, /v4 等）
    if (/\/v\d+$/.test(trimmed)) {
      candidates.push(`${trimmed}/models`);
      // 非 /v1 的情况，追加 /v1/models 作为兜底
      if (!trimmed.endsWith("/v1")) candidates.push(`${trimmed}/v1/models`);
    } else {
      candidates.push(`${trimmed}/v1/models`);
    }

    // 命中兼容子路径时，剥离后再试根路径
    for (const suffix of KNOWN_COMPAT_SUFFIXES) {
      if (trimmed.endsWith(suffix)) {
        const root = trimmed.slice(0, -suffix.length).replace(/\/+$/, "");
        if (root && root.includes("://")) {
          candidates.push(`${root}/v1/models`);
          candidates.push(`${root}/models`);
        }
        break;
      }
    }

    return Array.from(new Set(candidates));
  }
}

/**
 * /help - 显示帮助信息
 */
export class HelpCommand implements CommandHandler {
  match(text: string): boolean {
    return text.trim() === "/help";
  }

  async execute(): Promise<CommandResult | null> {
    return {
      card: markdownCard(`**可用指令**

\`/model\` - 查看并切换 AI 模型（仅管理员）
\`/perm\` - 查看权限组与技能/工具分布（仅管理员）
\`/login\` - 登录飞书用户身份（Device Flow 授权，用于"我的视角"能力）
\`/logout\` - 退出用户身份登录
\`/help\` - 显示此帮助信息
\`/new\` - 开始新对话（清空历史）
\`/stop\` - 停止当前 AI 响应
\`/detail on\` - 开启详细模式（工具调用保留在正文）
\`/detail off\` - 开启精简模式（工具调用临时显示后清除，默认）`),
    };
  }
}

/**
 * /new - 清空当前会话历史，开始新对话。
 * 清空操作经构造注入（ConversationManager.clear）；话题内共享会话，禁止清空。
 */
export class NewCommand implements CommandHandler {
  private readonly clear: (conversationId: string) => Promise<void>;

  constructor(clear: (conversationId: string) => Promise<void>) {
    this.clear = clear;
  }

  match(text: string): boolean {
    return text.trim() === "/new";
  }

  async execute(message: FeishuInboundMessage): Promise<CommandResult | null> {
    const conversationId = message.context.conversationId;
    // 话题会话为所有人共享，不允许单人清空
    if (conversationId.startsWith("topic:")) {
      logger.info(`[Command] 话题内禁止 /new: ${conversationId}`);
      return { card: markdownCard("❌ 话题内禁止使用 /new（话题会话为所有人共享），请在群聊或私聊中使用。") };
    }
    await this.clear(conversationId);
    logger.info(`[Command] 已清空会话: ${conversationId}`);
    return { card: markdownCard("✅ 已清空对话历史，开始新的对话。") };
  }
}

/**
 * /stop - 中断当前会话正在生成的响应。
 * 中断操作经构造注入（ConversationManager.abort）。
 */
export class StopCommand implements CommandHandler {
  private readonly abort: (conversationId: string) => Promise<void>;

  constructor(abort: (conversationId: string) => Promise<void>) {
    this.abort = abort;
  }

  match(text: string): boolean {
    return text.trim() === "/stop";
  }

  async execute(message: FeishuInboundMessage): Promise<CommandResult | null> {
    await this.abort(message.context.conversationId);
    logger.info(`[Command] 已中断会话: ${message.context.conversationId}`);
    return { card: markdownCard("⏸️ 已停止当前响应。") };
  }
}

/**
 * /detail - 切换详细/精简模式
 * 切换逻辑通过回调交给调用方（FeishuAgentBridge 持有模式状态），返回是否已开启详细模式
 */
export class DetailCommand implements CommandHandler {
  private readonly setMode: (chatId: string, enabled: boolean) => void;
  private readonly getMode: (chatId: string) => boolean;

  constructor(setMode: (chatId: string, enabled: boolean) => void, getMode: (chatId: string) => boolean) {
    this.setMode = setMode;
    this.getMode = getMode;
  }

  match(text: string): boolean {
    return /^\/detail( on| off)?$/i.test(text.trim());
  }

  async execute(message: FeishuInboundMessage): Promise<CommandResult | null> {
    const arg = message.text.trim().split(/\s+/)[1]?.toLowerCase();
    const chatId = message.context.chatId;
    let statusLine: string;

    if (arg === "on" || arg === "off") {
      // 显式指定 on/off：设置并回执
      const enabled = arg === "on";
      this.setMode(chatId, enabled);
      statusLine = enabled
        ? "✅ 已开启**详细模式**：工具调用过程将保留在正文中。\n\n发送 `/detail off` 切换回精简模式。"
        : "✅ 已开启**精简模式**：工具调用仅在执行时临时显示，完成后只保留正文。\n\n发送 `/detail on` 切换到详细模式。";
    } else {
      // 无参数：显示当前模式
      statusLine = `当前模式：**${this.getMode(chatId) ? "详细模式" : "精简模式"}**\n\n发送 \`/detail on\` 开启详细模式，\`/detail off\` 开启精简模式。`;
    }

    return { card: markdownCard(statusLine) };
  }
}

/** /perm 展示用的策略概览：各组配置与生效范围（PermissionPolicy.describe 的返回） */
type PolicyOverview = Awaited<ReturnType<PermissionPolicy["describe"]>>;

/**
 * /perm - 查看权限配置（仅管理员）
 */
export class PermCommand implements CommandHandler {
  private readonly listPolicy: () => Promise<PolicyOverview>;

  constructor(listPolicy: () => Promise<PolicyOverview>) {
    this.listPolicy = listPolicy;
  }

  match(text: string): boolean {
    return text.trim() === "/perm";
  }

  async execute(message: FeishuInboundMessage): Promise<CommandResult | null> {
    if (!message.context.isAdmin) {
      return { card: markdownCard("⚠️ 仅管理员可查看权限配置") };
    }

    const policy = await this.listPolicy();
    const fmtAllow = (e: { bash?: string[]; read?: string[]; write?: string[]; tools?: string[] }): string[] => {
      const groups: [string, string[]][] = [
        ["Read", e.read ?? []],
        ["Write", e.write ?? []],
        ["Tools", e.tools ?? []],
        ["Bash", e.bash ?? []],
      ];
      const out: string[] = [];
      for (const [tag, items] of groups) {
        if (items.length === 0) continue;
        if (out.length) out.push("");
        for (const p of items) out.push(`${tag}(${p})`);
      }
      return out;
    };

    const lines: string[] = [];

    for (const [name, g] of Object.entries(policy.groups)) {
      const entries = fmtAllow(g.effective);
      lines.push(`**${name}**`, entries.length ? entries.join("\n") : "（空）", "");
    }

    lines.push("ℹ️ 名单外的调用由智能体参考本策略综合判断，仍不放行则弹授权卡。");

    return { card: markdownCard(lines.join("\n")) };
  }
}

/** 指令注册表：按注册顺序找第一个 match 的处理器 */
export class CommandRegistry {
  private handlers: CommandHandler[] = [];

  register(handler: CommandHandler): void {
    this.handlers.push(handler);
  }

  /** 查找匹配的指令处理器 */
  find(text: string): CommandHandler | null {
    return this.handlers.find((h) => h.match(text)) || null;
  }
}

/**
 * 创建默认指令注册表：/model /help。
 * /new /stop 需要会话操作依赖，由 bridge 在注册时以 NewCommand/StopCommand 注入；
 * /detail /perm /login /logout 等同样由 bridge/main 按需追加注册。
 */
export function createDefaultRegistry(modelInfo?: () => ModelInfo): CommandRegistry {
  const registry = new CommandRegistry();
  if (modelInfo) registry.register(new ModelCommand(modelInfo));
  registry.register(new HelpCommand());
  return registry;
}
