import { ConversationManager } from "../runtime/conversation-manager.ts";
import type { FeishuInboundMessage, FeishuEventHandler, FeishuTransport } from "./types.ts";
import { ThrottledReply } from "./throttled-reply.ts";

/** 将飞书消息转换为 Pi 会话，并把增量文本交给飞书传输层。 */
export class FeishuAgentBridge {
  private readonly conversations: ConversationManager;
  private readonly transport: FeishuTransport;
  private readonly onEvent?: FeishuEventHandler;

  constructor(conversations: ConversationManager, transport: FeishuTransport, onEvent?: FeishuEventHandler) {
    this.conversations = conversations;
    this.transport = transport;
    this.onEvent = onEvent;
  }

  /** 注册飞书消息处理器。 */
  start(): void {
    this.transport.onMessage((message) => this.handle(message));
  }

  /** 处理一条入站消息。 */
  async handle(message: FeishuInboundMessage): Promise<void> {
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
    } catch (error) {
      await reply.close("处理失败，请稍后重试。");
      throw error;
    }
  }
}
