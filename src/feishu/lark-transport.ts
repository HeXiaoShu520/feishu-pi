import { createLarkChannel, type LarkChannel } from "@larksuiteoapi/node-sdk";
import type { FeishuInboundMessage, FeishuReply, FeishuTransport } from "./types.ts";
import { LarkCli } from "./lark-cli.ts";
import { LarkImageProcessor } from "./image-processor.ts";
import { formatLogText } from "./log-utils.ts";
import type { Client } from "@larksuiteoapi/node-sdk";

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
}

/** 基于飞书官方高层 Channel 的最小消息传输实现。 */
export class LarkTransport implements FeishuTransport {
  private readonly channel: LarkChannel;
  private readonly botOpenId?: string;
  private readonly larkCli: LarkCli;
  private readonly imageProcessor?: LarkImageProcessor;
  private handler?: (message: FeishuInboundMessage) => Promise<void>;
  private messageHandlerRegistered = false;
  private connecting?: Promise<void>;

  constructor(config: LarkTransportConfig) {
    this.botOpenId = config.botOpenId;
    this.larkCli = new LarkCli(config.userProfileDir);
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
    this.channel.on("reconnecting", () => console.warn("[LarkTransport] 飞书 WebSocket 正在重连"));
    this.channel.on("reconnected", () => console.info("[LarkTransport] 飞书 WebSocket 已恢复"));
    this.channel.on("error", (error) => console.error("[LarkTransport] 飞书 WebSocket 错误", error));
  }

  /** 建立飞书长连接并开始接收消息。 */
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (!this.messageHandlerRegistered) {
      this.messageHandlerRegistered = true;
      this.channel.on("message", async (message) => {
        if (this.botOpenId && message.senderId === this.botOpenId) return;
        const chatId = message.chatId;
        const threadId = message.threadId;
        const conversationId = threadId ? `${chatId}:thread:${threadId}` : `chat:${chatId}`;
        try {
          const profile = await this.larkCli.getUserProfile(message.senderId);
          const displayName = profile.englishName ?? profile.openId;

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
          console.info(`[${displayName}] 收到消息${imageInfo}: ${msgPreview}`);

          await this.handler?.({
            messageId: message.messageId,
            chatId,
            context: {
              userOpenId: profile.openId,
              userName: displayName,
              departmentIds: profile.departmentIds,
              chatId,
              threadId,
              conversationId,
            },
            text: message.content,
            images,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`[${message.senderId}] ${detail}`);
          await this.channel.send(`无法读取用户资料：${detail}`, { text: `无法读取用户资料：${detail}` }, { replyTo: message.messageId, replyInThread: true });
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
        initial: this.processingCard("正在处理…"),
        producer: async (streamController) => {
          controller = streamController;
          resolveController?.(streamController);
          await new Promise<void>((resolve) => {
            streamControllerResolve = resolve;
          });
        },
      },
    }, { replyTo: message.messageId, replyInThread: true });
    controller = await controllerReady;
    streamPromise.catch((error) => console.error("[LarkTransport] CardKit 流式回复失败", error));
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
