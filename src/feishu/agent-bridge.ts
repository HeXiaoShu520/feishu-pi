import { ConversationManager } from "../runtime/conversation-manager.ts";
import type { FeishuPiSession } from "../runtime/types.ts";
import type { FeishuInboundMessage, FeishuEventHandler, FeishuTransport } from "./types.ts";
import { CardKitReply, resolveReplyInThread } from "./cardkit-reply.ts";
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
      /** 额外指令（如 /perm），注册在默认指令之后 */
      extraCommands?: CommandHandler[];
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
    for (const command of options?.extraCommands ?? []) {
      this.commandRegistry.register(command);
    }
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
      replyInThread: resolveReplyInThread(message.context.chatMode, message.context.threadId),
      onError: (err) => logger.error("[CardKit]", err),
    });

    // 动画定时器句柄提级声明：无论 prompt 成功或抛错，finally 都要清掉，避免句柄泄漏
    let animationTimer: NodeJS.Timeout | undefined;
    let toolTimer: NodeJS.Timeout | undefined;

    try {
      // 创建随机 spinner 实例
      const spinner = new Spinner();
      let hasRealContent = false;
      let textEvents = 0;
      let lastTextLength = -1;
      let session: FeishuPiSession | undefined;

      // parts 模型：正文与工具摘要各为一段。精简模式滚动回收（旧工具段/旧正文置空），
      // 终态只保留最后一个工具段之后的结论；详细模式全量保留。
      const parts: Array<{ kind: "text" | "tool"; text: string }> = [];
      const toolPartIndices: number[] = [];

      const render = () => reply.replace(parts.map((p) => p.text).join(""));

      /** 追加正文：同一 assistant 消息的增量并入当前段；新消息段出现时精简模式回收旧内容 */
      const appendText = (text: string): Promise<void> => {
        const last = parts[parts.length - 1];
        const extendsCurrent = last?.kind === "text" && text.startsWith(last.text);
        if (extendsCurrent) {
          const delta = text.slice(last.text.length);
          last.text = text;
          return delta ? reply.update(delta) : Promise.resolve();
        }
        // 新正文段：精简模式回收（旧工具段 + 旧正文全部置空，只留新段）
        const compact = this.detailMode.get(message.chatId) !== true;
        if (compact) for (const p of parts) p.text = "";
        parts.push({ kind: "text", text });
        return compact ? render() : reply.update(text);
      };

      /** 追加工具摘要段：工具段只留当前一个（新工具出现，上一个就地置空） */
      const appendTool = (toolLine: string): Promise<void> => {
        const compact = this.detailMode.get(message.chatId) !== true;
        if (compact) {
          const lastTool = toolPartIndices[toolPartIndices.length - 1];
          if (lastTool !== undefined) parts[lastTool].text = "";
        }
        parts.push({ kind: "tool", text: toolLine });
        toolPartIndices.push(parts.length - 1);
        return compact ? render() : reply.update(toolLine);
      };

      /** 终态组装：详细=全量保留；精简=最后一个工具段之后的正文（无则退回全部非工具段），不丢已见内容 */
      const composeFinal = (): string => {
        if (this.detailMode.get(message.chatId) === true) return parts.map((p) => p.text).join("");
        if (toolPartIndices.length > 0) {
          const tail = parts.slice(Math.max(...toolPartIndices) + 1).map((p) => p.text).join("");
          if (tail.trim().length > 0) return tail;
        }
        return parts.filter((p) => p.kind !== "tool").map((p) => p.text).join("");
      };

      // 立即显示首帧（0ms 延迟）
      await reply.replace(spinner.next());

      // 启动动画定时器（真实内容到来前用 replace 循环刷新动画帧）
      let animationUpdating = false;
      animationTimer = setInterval(() => {
        if (!hasRealContent && !animationUpdating) {
          animationUpdating = true;
          reply.replace(spinner.next()).catch(() => {}).finally(() => {
            animationUpdating = false;
          });
        }
      }, 200); // 200ms 更新一帧

      // 工具调用动画：在小字位置显示"符号 + 工具名"的旋转帧
      const TOOL_FRAMES = ["⚙", "⚙", "⚒", "⚒", "🛠", "⚒", "⚙"];
      let toolFrameIndex = 0;
      let activeToolName = "";
      let toolAnimationUpdating = false;
      toolTimer = setInterval(() => {
        if (hasRealContent && activeToolName && !toolAnimationUpdating) {
          toolAnimationUpdating = true;
          const frame = TOOL_FRAMES[toolFrameIndex++ % TOOL_FRAMES.length];
          reply.updateStats(`${frame} ${activeToolName} …`).catch(() => {}).finally(() => {
            toolAnimationUpdating = false;
          });
        }
      }, 300);

      // 记录 prompt 前的基线统计，用于计算本次新增 token
      const statsBefore = await this.conversations.getStats(conversationId, message.context);

      // 首个真实内容（正文或工具调用）到达时的公共收尾：
      // 停掉思考动画、清空累积器并清掉卡片上残留的 spinner 帧，避免动画文字混入正文
      let startedRealContent = false;
      const startRealContent = async () => {
        if (startedRealContent) return;
        startedRealContent = true;
        hasRealContent = true;
        clearInterval(animationTimer);
        await reply.replace("");
      };

      session = await this.conversations.prompt(
        {
          conversationId,
          prompt: { text: message.text, images: message.images, context: message.context },
          context: message.context  // 传递完整的上下文
        },
        async (event) => {
          await this.onEvent?.(event, message);
          if (event.type === "assistant_text") {
            textEvents += 1;
            lastTextLength = event.text.length;
            if (!hasRealContent) await startRealContent();
            await appendText(event.text);
          }
          // 工具事件：追加工具摘要段（精简模式只留当前一个），小字位置同步显示动画。
          if (event.type === "tool_started") {
            activeToolName = event.toolName;
            if (!hasRealContent) await startRealContent();
            await appendTool(`\n\n> ⚙ ${formatToolCall(event.toolName, event.args)}`);
          }
          if (event.type === "tool_finished") {
            activeToolName = "";
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
        const deltaTokens = Math.max(0, (tokens.total || 0) - (statsBefore?.tokens?.total || 0));
        const cost = typeof stats.cost === "number" ? `$${stats.cost.toFixed(4)}` : "";
        const elapsed = `${((Date.now() - requestStartedAt) / 1000).toFixed(1)}s`;
        // ctx：当前上下文占用百分比（模型窗口口径，区别于上面的累计计费 token）
        const usage = session?.getContextUsage?.();
        const ctx = usage?.percent != null ? `ctx ~${Math.round(usage.percent)}%` : "";
        statsLine = [session.getModelName?.() || "模型未知", `${formatTokens(tokens.total || 0)}（新增 ${formatTokens(deltaTokens)}）`, ctx, cost, elapsed, sessionAlias(stats.sessionId)].filter(Boolean).join(" · ");
      }

      // 终态：详细=全量；精简=最后一个工具段之后的结论段
      const finalText = composeFinal();
      await reply.close(finalText, statsLine);

      // 记录最终响应（含耗时；空文本单独特警，便于发现模型无输出/被拦截的情况）
      const replyPreview: string = formatLogText(finalText) || "";
      const elapsedSec = ((Date.now() - requestStartedAt) / 1000).toFixed(1);
      if (!replyPreview) {
        logger.warn(
          `[Bridge] 模型未返回文本内容（文本事件 ${textEvents} 次，末次长度 ${lastTextLength}，耗时 ${elapsedSec}s）` +
            "——请复现一次并把这条日志发给维护者定位",
        );
      }
      logger.aiResponse(userName || "未知用户", `响应完成(${elapsedSec}s): ${replyPreview}`);

      await this.messages?.complete(message.messageId);
    } catch (error) {
      await this.messages?.fail(message.messageId);
      const errorMessage = error instanceof Error ? error.message : String(error);
      // 关闭失败不能掩盖原始错误，记日志后仍上抛
      await reply.close(`处理失败：${errorMessage}`).catch((closeErr) => logger.error("[Bridge] 关闭回复卡失败:", closeErr));
      throw error;
    } finally {
      // 动画定时器兜底清理（prompt 抛错时走这里；已清理过的句柄重复 clear 是无害的）
      clearInterval(animationTimer);
      clearInterval(toolTimer);
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

      // 特殊处理 /new 指令：清空会话；话题内共享会话，禁止清空
      if (message.text.trim() === "/new") {
        if (message.context.conversationId.startsWith("topic:")) {
          logger.info(`[Command] 话题内禁止 /new: ${message.context.conversationId}`);
          await this.sendCommandCard(message, {
            schema: "2.0",
            body: { elements: [{ tag: "markdown", content: "❌ 话题内禁止使用 /new（话题会话为所有人共享），请在群聊或私聊中使用。" }] },
          });
          await this.messages?.complete(message.messageId);
          return;
        }
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

      // 发送卡片回复；message_id 回传给 afterSend（如 /login 轮询完成后原地更新卡片）
      const sentMessageId = await this.sendCommandCard(message, result.card);
      result.afterSend?.(sentMessageId);

      logger.info(`[Command] 卡片已发送`);

      await this.messages?.complete(message.messageId);
    } catch (error) {
      await this.messages?.fail(message.messageId);
      logger.error("[Command] 执行失败:", error);
    }
  }

  /** 发送指令卡片回复；话题群内以话题形式回帖到原话题（直接发消息会开出新话题）。返回卡片 message_id。 */
  private async sendCommandCard(message: FeishuInboundMessage, card: object): Promise<string | undefined> {
    if (!this.client) return undefined;
    if (message.context.chatMode === "topic") {
      const reply = await this.client.im.message.reply({
        path: { message_id: message.messageId },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(card),
          reply_in_thread: true,
        },
      });
      return extractMessageId(reply);
    }
    const res = await this.client.request({
      method: "POST",
      url: "/open-apis/im/v1/messages",
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: message.chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
        uuid: randomUUID(), // 幂等 ID（36 字符，满足飞书 ≤50 要求，防重试时重复发送）
      },
    }).catch((err) => {
      const errorDetail = err.response?.data?.error?.field_violations || err.response?.data || err.message;
      logger.error(`[Command] 发送卡片失败:`, JSON.stringify(errorDetail, null, 2));
      throw err;
    });
    return extractMessageId(res);
  }
}

/** 从飞书发送/回复响应中提取卡片 message_id（失败或结构不符时返回 undefined）。 */
function extractMessageId(res: unknown): string | undefined {
  const id = (res as { data?: { message_id?: string } } | undefined)?.data?.message_id;
  return typeof id === "string" ? id : undefined;
}

/** 工具调用行展示的最大字符数（防止超长命令/路径刷屏）。 */
const TOOL_CALL_MAX_CHARS = 300;

/**
 * 格式化一次工具调用的展示文本，把关键参数带出来：
 * bash 显示命令本身，read/write/edit/grep 显示目标路径，
 * 其余回退展示整包参数 JSON（单行、截断）。
 */
function formatToolCall(toolName: string, args: unknown): string {
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const firstString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      if (typeof record[key] === "string" && record[key]) return record[key] as string;
    }
    return undefined;
  };

  let detail: string | undefined;
  if (toolName === "bash" || toolName === "execute" || toolName === "run_command") {
    detail = firstString("command", "cmd");
  } else if (toolName === "write" || toolName === "edit" || toolName === "read" || toolName === "restricted_read") {
    detail = firstString("path", "file_path", "filePath");
  } else if (toolName === "grep" || toolName === "glob" || toolName === "find") {
    detail = firstString("pattern", "path");
  } else {
    detail = firstString("path", "file_path", "filePath", "url", "name", "skill", "script");
  }

  // 兜底：无法从常用字段提取时，展示整包参数（单行截断）
  if (!detail) {
    try {
      detail = JSON.stringify(args)?.replace(/\s+/g, " ");
    } catch {
      detail = undefined;
    }
  }
  if (!detail) return `正在调用 **${toolName}** …`;
  if (detail.length > TOOL_CALL_MAX_CHARS) detail = `${detail.slice(0, TOOL_CALL_MAX_CHARS)}…`;
  const escaped = detail.replace(/\n/g, " ").replace(/`/g, "'");
  return `正在调用 **${toolName}**：\`${escaped}\``;
}
