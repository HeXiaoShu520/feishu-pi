import { ConversationManager } from "../runtime/conversation-manager.ts";
import type { FeishuInboundMessage, FeishuEventHandler, FeishuTransport } from "./types.ts";
import { ThrottledReply } from "./throttled-reply.ts";
import { MessageStore } from "./message-store.ts";

/** 将飞书消息转换为 Pi 会话，并把增量文本交给飞书传输层。 */
export class FeishuAgentBridge {
  private readonly conversations: ConversationManager;
  private readonly transport: FeishuTransport;
  private readonly onEvent?: FeishuEventHandler;
  private readonly messages?: MessageStore;

  constructor(conversations: ConversationManager, transport: FeishuTransport, onEvent?: FeishuEventHandler, messages?: MessageStore) {
    this.conversations = conversations;
    this.transport = transport;
    this.onEvent = onEvent;
    this.messages = messages;
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
    const reply = new ThrottledReply(await this.transport.startReply(message));
    try {
      await this.conversations.prompt(
        { conversationId, prompt: { text: message.text, images: message.images, context: message.context } },
        async (event) => {
          latestText = event.text;
          await this.onEvent?.(event, message);
          if (event.text) await reply.update(event.text);
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
