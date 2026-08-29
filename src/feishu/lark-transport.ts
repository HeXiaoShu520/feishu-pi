import { createLarkChannel, type LarkChannel } from "@larksuiteoapi/node-sdk";
import type { FeishuInboundMessage, FeishuReply, FeishuTransport } from "./types.ts";
import { LarkCli } from "./lark-cli.ts";

export interface LarkTransportConfig {
  appId: string;
  appSecret: string;
  botOpenId?: string;
  source?: string;
  userProfileDir?: string;
  handshakeTimeoutMs?: number;
  pingTimeout?: number;
}

/** 基于飞书官方高层 Channel 的最小消息传输实现。 */
export class LarkTransport implements FeishuTransport {
  private readonly channel: LarkChannel;
  private readonly botOpenId?: string;
  private readonly larkCli: LarkCli;
  private handler?: (message: FeishuInboundMessage) => Promise<void>;
  private messageHandlerRegistered = false;
  private connecting?: Promise<void>;

  constructor(config: LarkTransportConfig) {
    this.botOpenId = config.botOpenId;
    this.larkCli = new LarkCli(config.userProfileDir);
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
          console.info(`[${displayName} (${profile.openId})] 收到飞书消息`);
          await this.handler?.({
            messageId: message.messageId,
            context: {
              userOpenId: profile.openId,
              userName: displayName,
              departmentIds: profile.departmentIds,
              chatId,
              threadId,
              conversationId,
            },
            text: message.content,
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
    const result = await this.channel.send("", { text: "正在处理…" }, { replyTo: message.messageId, replyInThread: true });
    return {
      update: (text) => this.channel.editMessage(result.messageId, text),
      close: (text) => this.channel.editMessage(result.messageId, text || "（无响应）"),
    };
  }
}
