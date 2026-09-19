import { ConversationManager } from "../runtime/conversation-manager.ts";
import type { FeishuPiSession } from "../runtime/types.ts";
import type { FeishuInboundMessage, FeishuEventHandler, FeishuTransport } from "./types.ts";
import { CardKitReply, resolveReplyInThread } from "./cardkit-reply.ts";
import { MessageStore } from "./message-store.ts";
import { formatLogText } from "./log-utils.ts";
import { ReactionController } from "./reaction-controller.ts";
import { Spinner, randomFrames } from "./spinner.ts";
import type { Client } from "@larksuiteoapi/node-sdk";
import { logger } from "../utils/logger.ts";
import { createDefaultRegistry, DetailCommand, NewCommand, StopCommand, markdownCard, type CommandRegistry, type CommandHandler } from "./commands.ts";
import { randomUUID } from "node:crypto";
import { formatStatsLine, formatToolCall, toolIcon, ReplyParts } from "./reply-parts.ts";
import type { PeopleRoster } from "./people-roster.ts";

/** 将飞书消息转换为 Pi 会话，并把增量文本交给飞书传输层。 */
export class FeishuAgentBridge {
  private readonly conversations: ConversationManager;
  private readonly transport: FeishuTransport;
  private readonly onEvent?: FeishuEventHandler;
  private readonly messages?: MessageStore;
  private readonly client?: Client;
  private readonly reactionController?: ReactionController;
  private readonly commandRegistry: CommandRegistry;
  /** 详细模式开关：key 为 chatId，true 表示工具调用保留在正文中 */
  private readonly detailMode = new Map<string, boolean>();
  /** 回复末尾是否显示模型统计小字；关闭时只影响终态小字，工具过程状态照常显示 */
  private readonly showModelStats: boolean;
  /** 预制人员名单（可选）：把消息中按名字提到的人补成提示词，模型才能识别/@ 到人 */
  private readonly peopleRoster?: PeopleRoster;

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
      /** 额外指令（如 /perm），注册在默认指令之后 */
      extraCommands?: CommandHandler[];
      /** 回复末尾是否显示模型统计小字（默认显示）；工具过程状态不受影响 */
      showModelStats?: boolean;
      /** 模型信息提供器（/model 指令展示用）；返回运行中的实时值 */
      modelInfo?: () => { baseUrl?: string; modelName: string; apiKey: string };
      /** 预制人员名单（可选）：按名字提到的人自动补 open_id 提示 */
      peopleRoster?: PeopleRoster;
    },
  ) {
    this.conversations = conversations;
    this.transport = transport;
    this.onEvent = options?.onEvent;
    this.messages = options?.messages;
    this.client = options?.client;
    this.showModelStats = options?.showModelStats ?? true;
    this.peopleRoster = options?.peopleRoster;
    this.reactionController = options?.client ? new ReactionController(options.client) : undefined;
    this.commandRegistry = createDefaultRegistry(options?.modelInfo);
    // /detail on|off 设置详细/精简模式，状态由 bridge 持有（按 chatId 记忆，默认精简）
    this.commandRegistry.register(new DetailCommand(
      (chatId: string, enabled: boolean) => this.detailMode.set(chatId, enabled),
      (chatId: string) => this.detailMode.get(chatId) === true,
    ));
    // /new /stop 操作会话（清空/中断），实际逻辑由指令自身完成（见 commands.ts）
    this.commandRegistry.register(new NewCommand((id) => this.conversations.clear(id)));
    this.commandRegistry.register(new StopCommand((id) => this.conversations.abort(id)));
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
    const requestStartedAt = Date.now();

    // 检测是否为指令
    const commandHandler = this.commandRegistry.find(message.text);
    if (commandHandler) {
      await this.handleCommand(message, commandHandler);
      return;
    }

    // 添加随机表情 reaction
    await this.reactionController?.start(message.messageId);

    if (!this.client) {
      throw new Error("client 未配置，无法创建 CardKit 回复");
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

      // parts 模型（见 reply-parts.ts）：精简模式滚动回收，终态只留最后工具段之后的结论
      const replyParts = new ReplyParts(
        { render: (text) => reply.replace(text), append: (text) => reply.update(text) },
        () => this.detailMode.get(message.chatId) !== true,
      );

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

      // 工具调用动画：小字 = 工具类型图标（固定）+ 工具名 + 尾部 spinner 帧。
      // 每条回复随机锁定一种 spinner 样式（约 200ms/帧循环），工具切换只换前缀不换样式。
      const toolSpinner = new Spinner(" ", randomFrames());
      let activeToolName = "";
      let toolAnimationUpdating = false;
      toolTimer = setInterval(() => {
        if (hasRealContent && activeToolName && !toolAnimationUpdating) {
          toolAnimationUpdating = true;
          reply.updateStats(toolSpinner.next()).catch(() => {}).finally(() => {
            toolAnimationUpdating = false;
          });
        }
      }, 200);

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

      // 预制人员名单：消息里按名字提到的人在 prompt 末尾补 open_id 提示（仅影响发给模型的内容，
      // 指令路由/日志/消息原文不受影响）；名单查询失败按无提示处理
      let promptText = message.text;
      if (this.peopleRoster) {
        const hint = await this.peopleRoster.buildHint(message.text, message.context.userOpenId).catch(() => undefined);
        if (hint) promptText = `${message.text}\n\n${hint}`;
      }

      session = await this.conversations.prompt(
        {
          conversationId,
          prompt: { text: promptText, images: message.images },
          context: message.context, // 调用者身份（权限组判定、会话目录归属的依据）
        },
        async (event) => {
          await this.onEvent?.(event, message);
          if (event.type === "assistant_text") {
            textEvents += 1;
            lastTextLength = event.text.length;
            if (!hasRealContent) await startRealContent();
            // 回显脱敏：模型偶尔会把凭证原文带进正文——展示前遮蔽
            await replyParts.appendText(event.text);
          }
          // 工具事件：追加工具摘要段（精简模式只留当前一个），小字位置同步显示动画。
          // bash：只渲染命令代码块（不显示工具名）；其余工具保留「🛠 名称 + 参数」样式。
          if (event.type === "tool_started") {
            activeToolName = event.toolName;
            toolSpinner.withPrefix(`${toolIcon(event.toolName)} ${event.toolName}`);
            if (!hasRealContent) await startRealContent();
            await replyParts.appendTool(`\n\n${formatToolCall(event.toolName, event.args)}`);
          }
          if (event.type === "tool_finished") {
            activeToolName = "";
            // 清空小字，等待下一次工具调用或最终统计（完成状态不占正文，避免刷屏）
            await reply.updateStats(" ");
          }
        },
      );

      // 确保停止动画
      clearInterval(animationTimer);
      clearInterval(toolTimer);

      // 终态统计小字在 close 内部（正文渲染完成后）才写入；配置关闭时不生成，
      // 工具过程状态（工具段 + 小字动画）不经过这里，照常显示
      const statsLine = this.showModelStats
        ? formatStatsLine({
            modelName: session?.getModelName?.(),
            stats: session?.getStats?.(),
            elapsedMs: Date.now() - requestStartedAt,
          })
        : undefined;
      if (this.showModelStats && !statsLine) {
        // 观测点：getStats 未返回数据时小字缺失（偶发），出现频率高需要查 pi 的统计链路
        logger.info(`[Bridge] 本轮无统计小字（会话统计不可用）: ${conversationId}`);
      }

      // 终态：详细=全量；精简=最后一个工具段之后的结论段
      const finalText = replyParts.composeFinal();
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
      // 指令日志脱敏：/login <provider> <token> 这类携带凭证的指令不落原文
      const logText = /^\/login\s+\S+(\s+\S+)/.test(message.text.trim())
        ? message.text.trim().replace(/^(\/login\s+\S+\s+)\S+([\s\S]*)$/, "$1***$2")
        : message.text;
      logger.info(`[${message.context.userName}] 执行指令: ${logText}`);

      // 特殊处理 /new 指令：清空会话；话题内共享会话，禁止清空。
      // 动作完成后直接 return——registry 里的 NewCommand 会重复执行 clear，
      // 两次 clear 之间若并发消息刚重建会话，会被二次 clear 错杀成孤儿。
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
        await this.sendCommandCard(message, markdownCard("✅ 已清空对话历史，开始新的对话。"));
        await this.messages?.complete(message.messageId);
        return;
      }

      // 特殊处理 /stop 指令：中断当前响应（同理，registry 里的 StopCommand 会重复 abort）
      if (message.text.trim() === "/stop") {
        await this.conversations.abort(message.context.conversationId);
        logger.info(`[Command] 已中断会话: ${message.context.conversationId}`);
        await this.sendCommandCard(message, markdownCard("⏸️ 已停止当前响应。"));
        await this.messages?.complete(message.messageId);
        return;
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
      // 尽力给用户一张错误卡（失败原因不能只留在日志里）；发卡再失败则静默
      const detail = formatLogText(error instanceof Error ? error.message : String(error), 200);
      await this.sendCommandCard(message, markdownCard(`❌ 指令执行失败：${detail}`)).catch(() => undefined);
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
