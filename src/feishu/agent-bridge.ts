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
