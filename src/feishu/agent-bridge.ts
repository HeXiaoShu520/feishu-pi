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
import { createDefaultRegistry, DetailCommand, type CommandRegistry, type CommandHandler } from "./commands.ts";
import { randomUUID } from "node:crypto";
import { sessionAlias } from "./session-alias.ts";

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
  /** 详细模式开关：key 为 chatId，true 表示工具调用保留在正文中 */
  private readonly detailMode = new Map<string, boolean>();

  /** 查询某会话是否开启详细模式（供授权卡撤回等外部逻辑判断）。 */
  isDetailMode(chatId: string): boolean {
    return this.detailMode.get(chatId) === true;
  }

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
    // /detail on|off 设置详细/精简模式，状态由 bridge 持有（按 chatId 记忆，默认精简）
    this.commandRegistry.register(new DetailCommand(
      (chatId: string, enabled: boolean) => this.detailMode.set(chatId, enabled),
      (chatId: string) => this.detailMode.get(chatId) === true,
    ));
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
    const requestStartedAt = Date.now();

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
      // 详细模式下追加到正文尾部的工具调用记录
      let toolLog = "";

      // 立即显示首帧（0ms 延迟）
      await (reply as any).replace(spinner.next());

      // 启动动画定时器（真实内容到来前显示动画）
      let animationUpdating = false;
      const animationTimer = setInterval(() => {
        if (!hasRealContent && !animationUpdating) {
          animationUpdating = true;
          // 用 replace 替换内容，不累加
          (reply as any).replace(spinner.next()).finally(() => {
            animationUpdating = false;
          });
        }
      }, 200); // 200ms 更新一帧

      // 工具调用动画：在小字位置显示"符号 + 工具名"的旋转帧
      const TOOL_FRAMES = ["⚙", "⚙", "⚒", "⚒", "🛠", "⚒", "⚙"];
      let toolFrameIndex = 0;
      let activeToolName = "";
      let toolAnimationUpdating = false;
      const toolTimer = setInterval(() => {
        if (hasRealContent && activeToolName && !toolAnimationUpdating) {
          toolAnimationUpdating = true;
          const frame = TOOL_FRAMES[toolFrameIndex++ % TOOL_FRAMES.length];
          reply.updateStats(`${frame} ${activeToolName} …`).finally(() => {
            toolAnimationUpdating = false;
          });
        }
      }, 300);

      // 记录 prompt 前的基线统计，用于计算本次新增 token
      const statsBefore = await this.conversations.getStats(conversationId, message.context);

      session = await this.conversations.prompt(
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
              latestText = "";
            }

            const prevText = latestText;
            latestText = event.text;
            // 只传增量给 update
            const delta = event.text.slice(prevText.length);
            // logger.log(`[Debug] prevText.length=${prevText.length}, latestText.length=${latestText.length}, delta="${delta}"`);
            if (delta) await reply.update(delta);
          }
          // 工具事件：正文写入（详细模式保留 / 精简模式临时显示），小字位置同步显示动画。
          if (event.type === "tool_started") {
            activeToolName = event.toolName;
            const toolLine = `\n\n> ⚙ 正在调用 **${event.toolName}** …`;
            if (this.detailMode.get(message.chatId)) {
              // 详细模式：工具调用永久保留在正文
              toolLog += toolLine;
              await reply.update(toolLine);
            } else {
              // 精简模式：临时显示，结束后清除
              await reply.showTransient(toolLine);
            }
          }
          if (event.type === "tool_finished") {
            activeToolName = "";
            if (!this.detailMode.get(message.chatId)) {
              // 精简模式：去掉工具调用文字，只保留正文
              await reply.clearTransient();
            }
            // 清空小字，等待下一次工具调用或最终统计
            await reply.updateStats(" ");
          }
        },
      );

      // 确保停止动画
      clearInterval(animationTimer);
      clearInterval(toolTimer);

      const stats = session?.getStats?.();
      // 小字在 close 内部（正文渲染完成后）才写入
      let statsLine: string | undefined;
      if (stats) {
        const tokens = stats.tokens ?? {};
        const formatTokens = (value: number) => `${(value / 1000).toFixed(1)}K`;
        // 本次新增 token = 当前上下文 - prompt 前基线
        const deltaTokens = Math.max(0, (tokens.total || 0) - ((statsBefore as any)?.tokens?.total || 0));
        const cost = typeof stats.cost === "number" ? `$${stats.cost.toFixed(4)}` : "";
        const elapsed = `${((Date.now() - requestStartedAt) / 1000).toFixed(1)}s`;
        statsLine = [session.getModelName?.() || "模型未知", `${formatTokens(tokens.total || 0)}（新增 ${formatTokens(deltaTokens)}）`, cost, elapsed, sessionAlias(stats.sessionId)].filter(Boolean).join(" · ");
      }

      // logger.log(`[Debug] finalize with latestText="${latestText}"`);
      // 详细模式：最终内容需要包含工具调用记录
      await reply.close(this.detailMode.get(message.chatId) ? latestText + toolLog : latestText, statsLine);

      // 记录最终响应
      const replyPreview: string = formatLogText(latestText) || "";
      logger.aiResponse(userName || "未知用户", `响应完成: ${replyPreview}`);

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
      const response = await this.client.request({
        method: "POST",
        url: "/open-apis/im/v1/messages",
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: message.chatId,
          msg_type: "interactive",
          content: JSON.stringify(result.card),
          uuid: randomUUID(), // 飞书要求 uuid 最长 50 个字符
        },
      }).catch((err) => {
        const errorDetail = err.response?.data?.error?.field_violations || err.response?.data || err.message;
        logger.error(`[Command] 发送卡片失败:`, JSON.stringify(errorDetail, null, 2));
        throw err;
      });

      logger.info(`[Command] 卡片已发送`);

      await this.messages?.complete(message.messageId);
    } catch (error) {
      await this.messages?.fail(message.messageId);
      logger.error("[Command] 执行失败:", error);
    }
  }
}
