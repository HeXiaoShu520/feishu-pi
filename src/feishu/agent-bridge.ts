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

/** 工具段延迟上屏阈值：工具运行满该时长才显示工具段与小字动画，快速指令不刷屏。 */
const TOOL_SEGMENT_DELAY_MS = 1000;

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
    // 工具段延迟上屏句柄：快速工具（<1s 完成）不展示，避免快速指令来回刷屏
    let pendingToolTimer: NodeJS.Timeout | undefined;

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

      // 立即显示首帧（0ms 延迟）——动画帧走 replaceVisual：只改展示、不污染内容累积器
      await reply.replaceVisual(spinner.next());
      // 本轮是否被新消息 /stop 打断：结算时据此撤回复卡（而不是渲染半截内容+统计）
      let interruptedByNewMessage = false;

      // 启动动画定时器（真实内容到来前用 replaceVisual 循环刷新动画帧）
      let animationUpdating = false;
      // 在途帧写入句柄：停止动画时先等它落定，保证后续真实内容覆盖在最后
      let pendingAnimWrite: Promise<unknown> = Promise.resolve();
      animationTimer = setInterval(() => {
        if (!hasRealContent && !animationUpdating) {
          animationUpdating = true;
          pendingAnimWrite = reply.replaceVisual(spinner.next()).catch(() => {});
          pendingAnimWrite.finally(() => {
            animationUpdating = false;
          });
        }
      }, 200); // 200ms 更新一帧

      // 工具调用动画：小字 = 工具类型图标（固定）+ 工具名 + 尾部 spinner 帧。
      // 每条回复随机锁定一种 spinner 样式（约 200ms/帧循环），工具切换只换前缀不换样式。
      const toolSpinner = new Spinner(" ", randomFrames());
      let activeToolName = "";
      let toolAnimationUpdating = false;
      let pendingToolFrameWrite: Promise<unknown> = Promise.resolve();
      toolTimer = setInterval(() => {
        if (hasRealContent && activeToolName && !toolAnimationUpdating) {
          toolAnimationUpdating = true;
          pendingToolFrameWrite = reply.updateStats(toolSpinner.next()).catch(() => {});
          pendingToolFrameWrite.finally(() => {
            toolAnimationUpdating = false;
          });
        }
      }, 200);

      // 首个真实内容（正文或工具调用）到达时的公共收尾：停掉思考动画。
      // 不主动清空卡片——清空会造成"动画停→卡片空白→正文才来"的空窗；
      // spinner 停在最后一帧，由首个真实内容（正文 replace / 工具段）整体覆盖
      let startedRealContent = false;
      const startRealContent = async () => {
        if (startedRealContent) return;
        startedRealContent = true;
        hasRealContent = true;
        clearInterval(animationTimer);
        await pendingAnimWrite;
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
          // 工具段延迟 1s 上屏：跑得比 1s 快的工具（快速指令）什么都不显示，不刷屏；
          // 满 1s 仍在运行才追加代码块并启动小字动画。
          if (event.type === "tool_started") {
            if (!hasRealContent) await startRealContent();
            const toolName = event.toolName;
            const segment = `\n\n${formatToolCall(toolName, event.args)}`;
            clearTimeout(pendingToolTimer);
            pendingToolTimer = setTimeout(() => {
              pendingToolTimer = undefined;
              activeToolName = toolName;
              toolSpinner.withPrefix(`${toolIcon(toolName)} ${toolName}`);
              void replyParts.appendTool(segment).catch(() => {});
            }, TOOL_SEGMENT_DELAY_MS);
          }
          if (event.type === "tool_finished") {
            // 先停动画再清小字：等在途动画帧落定后写入清空，保证清空是最后一笔——
            // 否则迟到的帧会覆盖清空，把"⚙ bash ◀"冻在卡片上直到收尾
            activeToolName = "";
            if (pendingToolTimer) {
              // 工具在 1s 内跑完：工具段从未上屏，直接丢弃（连小字动画都没启动过）
              clearTimeout(pendingToolTimer);
              pendingToolTimer = undefined;
            } else {
              await pendingToolFrameWrite;
              // 清空小字，等待下一次工具调用或最终统计（完成状态不占正文，避免刷屏）
              await reply.updateStats(" ");
            }
          }
        },
        () => {
          interruptedByNewMessage = true;
        },
      );

      // 确保停止动画（在途帧先落定：避免迟到的动画帧盖过 close 写入的最终统计小字）
      clearInterval(animationTimer);
      clearInterval(toolTimer);
      await pendingAnimWrite;
      await pendingToolFrameWrite;

      // 本轮被新消息 /stop 打断：直接撤回这张回复卡（半截内容没有展示价值，留着只会误导）
      if (interruptedByNewMessage) {
        await reply.recall().catch((error) => logger.warn("[Bridge] 撤回被打断的回复卡失败:", error));
        await this.messages?.complete(message.messageId);
        logger.info(`[Bridge] 本轮被打断，回复卡已撤回: ${conversationId}`);
        return;
      }

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
      clearTimeout(pendingToolTimer);
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
