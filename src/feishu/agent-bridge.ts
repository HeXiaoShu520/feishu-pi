import { ConversationManager } from "../runtime/conversation-manager.ts";
import type { FeishuInboundMessage, FeishuEventHandler, FeishuTransport } from "./types.ts";
import { ThrottledReply } from "./throttled-reply.ts";
import { CardKitReply } from "./cardkit-reply.ts";
import { MessageStore } from "./message-store.ts";
import { formatLogText } from "./log-utils.ts";
import { ReactionController } from "./reaction-controller.ts";
import { Spinner } from "./spinner.ts";
import type { Client } from "@larksuiteoapi/node-sdk";
import { logger } from "../utils/logger.ts";
import { createDefaultRegistry, type CommandRegistry, type CommandHandler } from "./commands.ts";

/** 将飞书消息转换为 Pi 会话，并把增量文本交给飞书传输层。 */
export class FeishuAgentBridge {
  private readonly conversations: ConversationManager;
  private readonly transport: FeishuTransport;
  private readonly onEvent?: FeishuEventHandler;
  private readonly messages?: MessageStore;
  private readonly client?: Client;
  private readonly enableCardKit: boolean;
  private readonly reactionController?: ReactionController;
  private readonly commandRegistry: CommandRegistry;

  constructor(
    conversations: ConversationManager,
    transport: FeishuTransport,
    options?: {
      onEvent?: FeishuEventHandler;
      messages?: MessageStore;
      client?: Client;
      enableCardKit?: boolean;
      enableReaction?: boolean;
    },
  ) {
    this.conversations = conversations;
    this.transport = transport;
    this.onEvent = options?.onEvent;
    this.messages = options?.messages;
    this.client = options?.client;
    this.enableCardKit = options?.enableCardKit ?? true;
    this.reactionController = options?.client && (options?.enableReaction ?? true)
      ? new ReactionController(options.client)
      : undefined;
    this.commandRegistry = createDefaultRegistry();
  }

  /** 注册飞书消息处理器。 */
  start(): void {
    this.transport.onMessage((message) => this.handle(message));
  }

  /** 处理一条入站消息。 */
  async handle(message: FeishuInboundMessage): Promise<void> {
    if (this.messages && !(await this.messages.claim(message.messageId))) return;
    const conversationId = message.context.conversationId;
    const userName = message.context.userName;
    let latestText = "";

    // 检测是否为指令
    const commandHandler = this.commandRegistry.find(message.text);
    if (commandHandler) {
      await this.handleCommand(message, commandHandler);
      return;
    }

    // 添加随机表情 reaction
    await this.reactionController?.start(message.messageId);

    // 只用 CardKit，不降级
    if (!this.client || !this.enableCardKit) {
      throw new Error("CardKit 未启用或 client 未配置");
    }

    const reply = new CardKitReply({
      client: this.client,
      chatId: message.chatId,
      messageId: message.messageId,
      threadId: message.context.threadId,
      onError: (err) => logger.error("[CardKit]", err),
    });

    try {
      // 创建随机 spinner 实例
      const spinner = new Spinner();
      let hasRealContent = false;
      let session: any;

      // 立即显示首帧（0ms 延迟）
      (reply as any).replace(spinner.next());

      // 启动动画定时器（真实内容到来前显示动画）
      const animationTimer = setInterval(() => {
        if (!hasRealContent) {
          // 用 replace 替换内容，不累加
          (reply as any).replace(spinner.next());
        }
      }, 200); // 200ms 更新一帧

      await this.conversations.prompt(
        {
          conversationId,
          prompt: { text: message.text, images: message.images, context: message.context },
          context: message.context  // 传递完整的上下文
        },
        async (event) => {
          await this.onEvent?.(event, message);
          if (event.type === "assistant_text") {
            // 收到第一个真实内容时：停止动画并清空累积器
            if (!hasRealContent) {
              hasRealContent = true;
              clearInterval(animationTimer);
              // logger.info(`[Animation] 收到真实内容，停止动画`);
              // 清空累积器，从头开始推送真实内容
              (reply as any).stream.accumulator = "";
              latestText = "";
            }

            const prevText = latestText;
            latestText = event.text;
            // 只传增量给 update
            const delta = event.text.slice(prevText.length);
            // logger.log(`[Debug] prevText.length=${prevText.length}, latestText.length=${latestText.length}, delta="${delta}"`);
            if (delta) await reply.update(delta);
          }
          if (event.type === "tool_started") await reply.update(`正在调用工具：${event.toolName}`);
          if (event.type === "tool_updated") await reply.update(`工具执行中：${event.toolName}`);
          if (event.type === "tool_finished" && event.isError) await reply.update(`工具执行失败：${event.toolName}`);
        },
      ).then(s => session = s);

      // 确保停止动画
      clearInterval(animationTimer);

      // 获取统计信息并追加到回复底部
      let finalText = latestText;
      if (session) {
        const stats = session.getStats();
        if (stats) {
          const inputTokens = stats.tokens?.input || 0;
          const outputTokens = stats.tokens?.output || 0;
          const cacheRead = stats.tokens?.cacheRead || 0;
          const cacheWrite = stats.tokens?.cacheWrite || 0;
          const totalTokens = stats.tokens?.total || 0;
          const cost = stats.cost || 0;

          // 从 sessionFile 提取模型名称和会话ID
          const modelName = this.conversations["runtime"]?.config?.modelName || "unknown";
          const sessionId = stats.sessionId || "unknown";

          // 格式化耗时（从创建到现在的时间差，近似值）
          const duration = "未知";

          // 构建统计行
          const statsLine = `\n\n---\n${modelName} · 输入 ${(inputTokens / 1000).toFixed(1)}K / 输出 ${(outputTokens / 1000).toFixed(1)}K · 缓存 ${(cacheRead / 1000).toFixed(1)}K/${(cacheWrite / 1000).toFixed(1)}K · ${duration} · ${sessionId.slice(0, 8)}`;
          finalText = latestText + statsLine;
        }
      }

      // logger.log(`[Debug] finalize with latestText="${latestText}"`);
      await reply.close(finalText);

      // 记录最终响应
      const replyPreview = formatLogText(latestText);
      logger.aiResponse(userName, `响应完成: ${replyPreview}`);

      await this.messages?.complete(message.messageId);
    } catch (error) {
      await this.messages?.fail(message.messageId);
      const errorMessage = error instanceof Error ? error.message : String(error);
      await reply.close(`处理失败：${errorMessage}`);
      throw error;
    } finally {
      // 移除 reaction
      await this.reactionController?.stop(message.messageId);
    }
  }

  /** 处理指令 */
  private async handleCommand(message: FeishuInboundMessage, handler: CommandHandler): Promise<void> {
    if (!this.client) {
      logger.error("[Command] client 未配置");
      return;
    }

    try {
      logger.info(`[${message.context.userName}] 执行指令: ${message.text}`);

      // 特殊处理 /new 指令：清空会话
      if (message.text.trim() === "/new") {
        await this.conversations.clear(message.context.conversationId);
        logger.info(`[Command] 已清空会话: ${message.context.conversationId}`);
      }

      // 特殊处理 /stop 指令：中断当前响应
      if (message.text.trim() === "/stop") {
        await this.conversations.abort(message.context.conversationId);
        logger.info(`[Command] 已中断会话: ${message.context.conversationId}`);
      }

      const result = await handler.execute(message, this.client);
      if (!result) return;

      // 发送卡片回复
      await this.client.request({
        method: "POST",
        url: "/open-apis/im/v1/messages",
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: message.chatId,
          msg_type: "interactive",
          content: JSON.stringify(result.card),
        },
      });

      await this.messages?.complete(message.messageId);
    } catch (error) {
      await this.messages?.fail(message.messageId);
      logger.error("[Command] 执行失败:", error);
    }
  }
}
