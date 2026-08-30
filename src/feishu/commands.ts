import type { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuInboundMessage } from "./types.ts";
import { logger } from "../utils/logger.ts";
import { loadConfig } from "../config.ts";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

/**
 * 指令处理器接口
 */
export interface CommandHandler {
  /** 检测消息是否为此指令 */
  match(text: string): boolean;
  /** 执行指令，返回卡片 JSON */
  execute(message: FeishuInboundMessage, client: Client): Promise<CommandResult | null>;
}

export interface CommandResult {
  /** 卡片 JSON */
  card: object;
  /** 是否需要回调处理（按钮点击） */
  needsCallback?: boolean;
}

/**
 * /model - 显示可用模型列表，点击按钮切换
 */
export class ModelCommand implements CommandHandler {
  match(text: string): boolean {
    return text.trim() === "/model";
  }

  async execute(message: FeishuInboundMessage, client: Client): Promise<CommandResult | null> {
    try {
      const config = loadConfig();

      // 必须配置中转站 URL
      if (!config.modelBaseUrl) {
        return {
          card: this.errorCard("未配置模型中转站 URL\n\n请在 .env 中配置:\nFEISHU_PI_MODEL_BASE_URL=https://your-proxy.com/v1"),
        };
      }

      let models: Array<{ model_id: string; name: string }> = [];
      let successBaseURL = "";  // 提到外层
      const apiKey = process.env.FEISHU_PI_MODEL_API_KEY || "";

      try {
        // 生成候选 /models URL 列表（参考 cc-switch 的智能候选逻辑）
        const candidates = this.buildModelUrlCandidates(config.modelBaseUrl);

        logger.info(`[ModelCommand] 尝试 ${candidates.length} 个候选端点`);

        // 按顺序尝试每个候选 URL
        let lastError: string | undefined;
        for (const modelsUrl of candidates) {
          try {
            logger.info(`[ModelCommand] 尝试: ${modelsUrl}`);

            // 直接用 fetch，不通过 OpenAI SDK（支持无密钥访问）
            const headers: Record<string, string> = {};
            if (apiKey) {
              headers["Authorization"] = `Bearer ${apiKey}`;
            }

            const response = await fetch(modelsUrl, { headers });

            if (!response.ok) {
              if (response.status === 404 || response.status === 405) {
                lastError = `HTTP ${response.status}`;
                continue;
              }
              throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }

            const data = await response.json();
            models = (data.data || []).map((m: any) => ({
              model_id: m.id,
              name: m.id
            }));

            if (models.length > 0) {
              successBaseURL = modelsUrl.replace(/\/models$/, "");
              logger.info(`[ModelCommand] 成功从 ${modelsUrl} 获取 ${models.length} 个模型`);
              break;
            }
          } catch (err: any) {
            // 404/405 继续尝试下一个候选
            if (err?.status === 404 || err?.status === 405) {
              lastError = `HTTP ${err.status}`;
              continue;
            }
            // 其他错误直接返回
            throw err;
          }
        }

        if (models.length === 0) {
          return {
            card: this.errorCard(`所有候选端点均失败\n\n最后错误: ${lastError || "未知"}`),
          };
        }
      } catch (err) {
        logger.error(`[ModelCommand] 从中转站获取模型列表失败:`, err);
        return {
          card: this.errorCard(`获取模型列表失败\n\n${err instanceof Error ? err.message : String(err)}`),
        };
      }

      // 构建 CardKit 2.0 卡片，包含模型按钮
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
          text: {
            tag: "plain_text",
            content: model.name,
          },
          behaviors: [
            {
              type: "callback",
              value: JSON.stringify({ action: "switch_model", model_id: model.model_id }),
            },
          ],
        })),
      ];

      return {
        card: {
          schema: "2.0",
          body: { elements },
        },
        needsCallback: true,
      };
    } catch (err) {
      logger.error("[ModelCommand] 执行失败:", err);
      return {
        card: this.errorCard("获取模型列表时出错"),
      };
    }
  }

  private errorCard(message: string): object {
    return {
      schema: "2.0",
      body: {
        elements: [{ tag: "markdown", content: `❌ ${message}` }],
      },
    };
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
    const endsWithVersion = /\/v\d+$/.test(trimmed);

    if (endsWithVersion) {
      // 如 https://api.example.com/v4 -> /v4/models
      candidates.push(`${trimmed}/models`);
      // 非 /v1 的情况，追加 /v1/models 作为兜底
      if (!trimmed.endsWith("/v1")) {
        candidates.push(`${trimmed}/v1/models`);
      }
    } else {
      // 标准情况：baseURL + /v1/models
      candidates.push(`${trimmed}/v1/models`);
    }

    // 检查是否命中兼容子路径，剥离后再试
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

    // 去重
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
      card: {
        schema: "2.0",
        body: {
          elements: [
            {
              tag: "markdown",
              content: `**可用指令**

\`/model\` - 查看并切换 AI 模型（仅管理员）
\`/help\` - 显示此帮助信息
\`/new\` - 开始新对话（清空历史）
\`/stop\` - 停止当前 AI 响应`,
            },
          ],
        },
      },
    };
  }
}

/**
 * /new - 清空当前会话历史
 */
export class NewCommand implements CommandHandler {
  match(text: string): boolean {
    return text.trim() === "/new";
  }

  async execute(message: FeishuInboundMessage): Promise<CommandResult | null> {
    // 实际清空逻辑由调用方在 ConversationManager 中执行
    return {
      card: {
        schema: "2.0",
        body: {
          elements: [
            {
              tag: "markdown",
              content: "✅ 已清空对话历史，开始新的对话。",
            },
          ],
        },
      },
    };
  }
}

/**
 * /stop - 停止当前 AI 响应
 */
export class StopCommand implements CommandHandler {
  match(text: string): boolean {
    return text.trim() === "/stop";
  }

  async execute(message: FeishuInboundMessage): Promise<CommandResult | null> {
    // 实际停止逻辑由调用方处理
    return {
      card: {
        schema: "2.0",
        body: {
          elements: [
            {
              tag: "markdown",
              content: "⏸️ 已停止当前响应。",
            },
          ],
        },
      },
    };
  }
}

/**
 * 指令注册表
 */
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
 * 创建默认指令注册表
 */
export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(new ModelCommand());
  registry.register(new HelpCommand());
  registry.register(new NewCommand());
  registry.register(new StopCommand());
  return registry;
}
