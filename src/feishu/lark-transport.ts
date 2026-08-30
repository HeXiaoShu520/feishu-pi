import { createLarkChannel, type LarkChannel } from "@larksuiteoapi/node-sdk";
import type { FeishuInboundMessage, FeishuReply, FeishuTransport } from "./types.ts";
import { LarkCli } from "./lark-cli.ts";
import { LarkImageProcessor } from "./image-processor.ts";
import { formatLogText } from "./log-utils.ts";
import type { Client } from "@larksuiteoapi/node-sdk";
import { logger } from "../utils/logger.ts";

export interface LarkTransportConfig {
  appId: string;
  appSecret: string;
  botOpenId?: string;
  source?: string;
  userProfileDir?: string;
  handshakeTimeoutMs?: number;
  pingTimeout?: number;
  /** 飞书 Client 实例（用于图片下载） */
  client?: Client;
  /** 图片缓存目录（可选） */
  imageCacheDir?: string;
  /** 管理员 Open ID（可选） */
  adminOpenId?: string;
}

/** 基于飞书官方高层 Channel 的最小消息传输实现。 */
export class LarkTransport implements FeishuTransport {
  private readonly channel: LarkChannel;
  private readonly botOpenId?: string;
  private readonly larkCli: LarkCli;
  private readonly imageProcessor?: LarkImageProcessor;
  private readonly adminOpenId?: string;
  private handler?: (message: FeishuInboundMessage) => Promise<void>;
  private messageHandlerRegistered = false;
  private connecting?: Promise<void>;

  constructor(config: LarkTransportConfig) {
    this.botOpenId = config.botOpenId;
    this.adminOpenId = config.adminOpenId;
    this.larkCli = new LarkCli(config.client!, config.appId, config.userProfileDir);
    if (config.client) {
      this.imageProcessor = new LarkImageProcessor(config.client, {
        cacheDir: config.imageCacheDir,
      });
    }
    this.channel = createLarkChannel({
      appId: config.appId,
      appSecret: config.appSecret,
      transport: "websocket",
      source: config.source ?? "feishu-pi",
      handshakeTimeoutMs: config.handshakeTimeoutMs ?? 15_000,
      wsConfig: { pingTimeout: config.pingTimeout ?? 30 },
      safety: { dedup: { maxEntries: 10_000, ttl: 10 * 60 * 1000 } },
    });
    this.channel.on("reconnecting", () => logger.warn("[LarkTransport] 飞书 WebSocket 正在重连"));
    this.channel.on("reconnected", () => logger.info("[LarkTransport] 飞书 WebSocket 已恢复"));
    this.channel.on("error", (error) => logger.error("[LarkTransport] 飞书 WebSocket 错误", error));
  }

  /** 建立飞书长连接并开始接收消息。 */
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (!this.messageHandlerRegistered) {
      this.messageHandlerRegistered = true;

      // 监听普通消息
      this.channel.on("message", async (message) => {
        if (this.botOpenId && message.senderId === this.botOpenId) return;
        const chatId = message.chatId;
        const threadId = message.threadId;
        try {
          const profile = await this.larkCli.getUserProfile(message.senderId, chatId);
          const displayName = profile.name || profile.englishName || profile.openId;

          // 构造 conversationId: userId-conversationId
          const baseConversationId = threadId ? `${chatId}:thread:${threadId}` : `chat:${chatId}`;
          const conversationId = `${profile.openId}-${baseConversationId}`;

          // 处理图片附件
          let images;
          let imageCount = 0;
          if (this.imageProcessor && message.resources && message.resources.length > 0) {
            const imageKeys = message.resources
              .filter((r) => r.type === "image")
              .map((r) => r.fileKey);

            if (imageKeys.length > 0) {
              imageCount = imageKeys.length;
              images = await this.imageProcessor.processImages(imageKeys);
            }
          }

          // 记录收到的消息
          const msgPreview = formatLogText(message.content);
          const imageInfo = imageCount > 0 ? `（含 ${imageCount} 张图片）` : "";
          logger.userInput(displayName, `收到消息${imageInfo}: ${msgPreview}`);

          // 过滤消息中的 @ 机器人标记
          let cleanedText = message.content;
          if (this.botOpenId) {
            // 匹配 @bot_xxx 或 <at user_id="bot_xxx"></at> 等格式
            cleanedText = cleanedText
              .replace(new RegExp(`<at\\s+user_id="${this.botOpenId}"[^>]*>.*?</at>`, "gi"), "")
              .replace(new RegExp(`@${this.botOpenId}\\s*`, "gi"), "")
              .trim();
          }

          // 判断是否为管理员
          const isAdmin = this.adminOpenId ? profile.openId === this.adminOpenId : false;

          await this.handler?.({
            messageId: message.messageId,
            chatId,
            context: {
              userOpenId: profile.openId,
              userName: displayName,
              departmentNames: profile.departmentNames,
              chatId,
              threadId,
              conversationId,
              isAdmin,
            },
            text: cleanedText,
            images,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          logger.error(`[${message.senderId}] ${detail}`);
          await this.channel.send(`无法读取用户资料：${detail}`, { text: `无法读取用户资料：${detail}` }, { replyTo: message.messageId, replyInThread: true });
        }
      });

      // 监听卡片回调事件
      this.channel.on("card_action", async (action: any) => {
        try {
          logger.info(`[CardAction] 收到卡片回调: ${action.userId}`);

          // 判断是否为管理员
          const isAdmin = this.adminOpenId ? action.userId === this.adminOpenId : false;

          if (!isAdmin) {
            logger.warn(`[CardAction] 非管理员点击卡片: ${action.userId}`);
            // 更新卡片显示权限错误
            await this.channel.updateCard(action.messageId, {
              schema: "2.0",
              body: {
                elements: [
                  {
                    tag: "markdown",
                    content: "❌ 仅管理员可执行此操作",
                  },
                ],
              },
            });
            return;
          }

          // 解析回调数据
          const value = JSON.parse(action.value);

          if (value.action === "switch_model") {
            logger.info(`[CardAction] 管理员切换模型: ${value.model_id}`);
            // TODO: 实际的模型切换逻辑，需要更新配置文件
            // 暂时只更新卡片提示
            await this.channel.updateCard(action.messageId, {
              schema: "2.0",
              body: {
                elements: [
                  {
                    tag: "markdown",
                    content: `✅ 已切换到模型：${value.model_id}\n\n（TODO: 实际切换逻辑待实现）`,
                  },
                ],
              },
            });
          }
        } catch (error) {
          logger.error("[CardAction] 处理卡片回调失败:", error);
        }
      });
    }
    this.connecting = this.channel.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  /** 关闭飞书长连接，并阻止主动关闭期间的重连竞争。 */
  async disconnect(): Promise<void> {
    await this.channel.disconnect();
  }

  onMessage(handler: (message: FeishuInboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async startReply(message: FeishuInboundMessage): Promise<FeishuReply> {
    type CardController = { update(next: object | ((current: object) => object)): Promise<void>; messageId: string; current: object };
    let controller: CardController | undefined;
    let resolveController: ((value: CardController) => void) | undefined;
    let streamControllerResolve: (() => void) | undefined;
    const controllerReady = new Promise<CardController>((resolve) => {
      resolveController = resolve;
    });
    const streamPromise = this.channel.stream(message.context.chatId, {
      card: {
        initial: this.processingCard(""),  // 不显示"正在处理"，用 reaction 表情代替
        producer: async (streamController) => {
          controller = streamController;
          resolveController?.(streamController);
          await new Promise<void>((resolve) => {
            streamControllerResolve = resolve;
          });
        },
      },
    }, { replyTo: message.messageId, replyInThread: false });
    controller = await controllerReady;
    streamPromise.catch((error) => logger.error("[LarkTransport] CardKit 流式回复失败", error));
    return {
      update: (text) => controller!.update(this.processingCard(text)),
      close: async (text) => {
        await controller!.update(this.finalCard(text || "（无响应）"));
        streamControllerResolve?.();
        await streamPromise;
      },
    };
  }

  private processingCard(text: string): object {
    return { schema: "2.0", body: { elements: [{ tag: "markdown", content: text }] } };
  }

  private finalCard(text: string): object {
    return { schema: "2.0", body: { elements: [{ tag: "markdown", content: text }] } };
  }
}
