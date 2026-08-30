import { ConversationManager } from "../runtime/conversation-manager.ts";
import type { FeishuInboundMessage, FeishuEventHandler, FeishuTransport } from "./types.ts";
import { ThrottledReply } from "./throttled-reply.ts";
import { CardKitReply } from "./cardkit-reply.ts";
import { MessageStore } from "./message-store.ts";
import type { Client } from "@larksuiteoapi/node-sdk";

/** 将飞书消息转换为 Pi 会话，并把增量文本交给飞书传输层。 */
export class FeishuAgentBridge {
  private readonly conversations: ConversationManager;
  private readonly transport: FeishuTransport;
  private readonly onEvent?: FeishuEventHandler;
  private readonly messages?: MessageStore;
  private readonly client?: Client;
  private readonly enableCardKit: boolean;

  constructor(
    conversations: ConversationManager,
    transport: FeishuTransport,
    options?: {
      onEvent?: FeishuEventHandler;
      messages?: MessageStore;
      client?: Client;
      enableCardKit?: boolean;
    },
  ) {
    this.conversations = conversations;
    this.transport = transport;
    this.onEvent = options?.onEvent;
    this.messages = options?.messages;
    this.client = options?.client;
    this.enableCardKit = options?.enableCardKit ?? true;
  }

  /** 注册飞书消息处理器。 */
  start(): void {
    this.transport.onMessage((message) => this.handle(message));
  }

  /** 处理一条入站消息。 */
  async handle(message: FeishuInboundMessage): Promise<void> {
    if (this.messages && !(await this.messages.claim(message.messageId))) return;
    const conversationId = message.context.conversationId;
    let latestText = "";

    // 创建回复：优先使用 CardKit，失败时自动降级
    const baseReply = new ThrottledReply(await this.transport.startReply(message));
    const reply = this.client && this.enableCardKit
      ? new CardKitReply({
          client: this.client,
          chatId: message.chatId,
          fallbackReply: baseReply,
          enableCardKit: true,
          onError: (err) => console.error("[CardKit]", err),
        })
      : baseReply;

    try {
      await this.conversations.prompt(
        { conversationId, prompt: { text: message.text, images: message.images, context: message.context } },
        async (event) => {
          await this.onEvent?.(event, message);
          if (event.type === "assistant_text") {
            latestText = event.text;
            if (event.text) await reply.update(event.text);
          }
          if (event.type === "tool_started") await reply.update(`正在调用工具：${event.toolName}`);
          if (event.type === "tool_updated") await reply.update(`工具执行中：${event.toolName}`);
          if (event.type === "tool_finished" && event.isError) await reply.update(`工具执行失败：${event.toolName}`);
        },
      );
      await reply.close(latestText);
      await this.messages?.complete(message.messageId);
    } catch (error) {
      await this.messages?.fail(message.messageId);
      await reply.close("处理失败，请稍后重试。");
      throw error;
    }
  }
}
