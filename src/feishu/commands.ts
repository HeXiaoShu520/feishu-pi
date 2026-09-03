import type { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuInboundMessage } from "./types.ts";
import { logger } from "../utils/logger.ts";
import { loadConfig } from "../config.ts";

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
  /** 是否需要回调处理（按钮点击） */
  needsCallback?: boolean;
}

/** 构建一张只含单段 Markdown 的 CardKit 2.0 卡片（指令回复的标准形态）。 */
function markdownCard(content: string): object {
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
 * /model - 显示可用模型列表，点击按钮切换（实际切换由卡片回调处理）
 */
export class ModelCommand implements CommandHandler {
  match(text: string): boolean {
    return text.trim() === "/model";
  }

  async execute(message: FeishuInboundMessage, _client: Client): Promise<CommandResult | null> {
    try {
      const config = loadConfig();

      // 必须配置中转站 URL
      if (!config.modelBaseUrl) {
        return { card: errorCard("未配置模型中转站 URL\n\n请在 .env 中配置:\nFEISHU_PI_MODEL_BASE_URL=https://your-proxy.com/v1") };
      }

      const apiKey = process.env.FEISHU_PI_MODEL_API_KEY || "";
      let models: Array<{ model_id: string; name: string }> = [];
      let successBaseURL = "";

      try {
        // 生成候选 /models URL 列表并按顺序尝试（参考 cc-switch 的智能候选逻辑）
        const candidates = this.buildModelUrlCandidates(config.modelBaseUrl);
        logger.info(`[ModelCommand] 尝试 ${candidates.length} 个候选端点`);

        let lastError: string | undefined;
        for (const modelsUrl of candidates) {
          try {
            logger.info(`[ModelCommand] 尝试: ${modelsUrl}`);

            // 直接用 fetch，不通过 OpenAI SDK（支持无密钥访问）
            const headers: Record<string, string> = {};
            if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
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
          } catch (err: any) {
            if (err?.status === 404 || err?.status === 405) {
              lastError = `HTTP ${err.status}`;
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
            ? `**可用模型列表**\n\n中转站: ${successBaseURL}\n当前: ${config.modelName}\n\n请选择要切换的模型：`
            : `**可用模型列表**\n\n中转站: ${successBaseURL}\n当前: ${config.modelName}\n\n⚠️ 仅管理员可切换模型`,
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
        needsCallback: true,
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
\`/help\` - 显示此帮助信息
\`/new\` - 开始新对话（清空历史）
\`/stop\` - 停止当前 AI 响应
\`/detail on\` - 开启详细模式（工具调用保留在正文）
\`/detail off\` - 开启精简模式（工具调用临时显示后清除，默认）`),
    };
  }
}

/**
 * 简单文本指令：命中固定文本时回复固定文案。
 * /new、/stop 这类"实际逻辑由调用方（FeishuAgentBridge）执行、这里只回执"的指令共用此类。
 */
class SimpleCommand implements CommandHandler {
  private readonly command: string;
  private readonly reply: string;

  constructor(command: string, reply: string) {
    this.command = command;
    this.reply = reply;
  }

  match(text: string): boolean {
    return text.trim() === this.command;
  }

  async execute(): Promise<CommandResult | null> {
    return { card: markdownCard(this.reply) };
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

/** 创建默认指令注册表（/new /stop 的实际逻辑在 FeishuAgentBridge.handleCommand 中） */
export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(new ModelCommand());
  registry.register(new HelpCommand());
  registry.register(new SimpleCommand("/new", "✅ 已清空对话历史，开始新的对话。"));
  registry.register(new SimpleCommand("/stop", "⏸️ 已停止当前响应。"));
  return registry;
}
