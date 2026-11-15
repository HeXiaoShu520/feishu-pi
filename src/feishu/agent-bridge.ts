import { ConversationManager, type InterruptReason } from "../runtime/conversation-manager.ts";
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
import { stripEmoji } from "../utils/emoji.ts";
import { STATS_PLACEHOLDER } from "./cardkit-stream.ts";
import type { PeopleRoster } from "./people-roster.ts";
import { annotatePeople } from "./inbound-content.ts";
import { stripStickerCommentary, StickerDelivery } from "../stickers/delivery.ts";
import { sendHumanReply, shouldUseCard } from "./human-reply.ts";
import type { MemoryService } from "../memory/service.ts";
import { ConversationPresence } from "../conversation/presence.ts";

/** 工具段延迟上屏阈值：工具运行满该时长才显示工具段与小字动画，快速指令不刷屏。 */
const TOOL_SEGMENT_DELAY_MS = 1000;

/** 收尾超时被新消息打断：旧卡定格的中止说明（半截内容不展示，留痕告知用户可重发） */
const INTERRUPT_NOTICE = "⏹ 上一条消息的任务已中止：新消息到达，未能在收尾窗口内完成，可重新发送继续。";

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
  /** 回复文字是否允许 emoji；关闭时发送前兜底剥离（提示层已约束模型） */
  private readonly replyEmoji: boolean;
  /** 预制人员名单（可选）：把消息中按名字提到的人补成提示词，模型才能识别/@ 到人 */
  private readonly peopleRoster?: PeopleRoster;
  private readonly botOpenId?: string;
  private readonly recordSticker?: (chatId: string, id: string, line: string) => Promise<void>;
  /** 待答提问的文字回答通道：命中即消费该条文本，不进模型 */
  private readonly answerAskText?: (openId: string, chatId: string, text: string) => boolean;
  /** 每轮开始回调：重置单轮工具调用计数 */
  private readonly onRoundStart?: (chatId: string) => void;
  /** 轻量长期记忆：只在入口注入、出口异步提炼，不放运行时里。 */
  private readonly memory?: Pick<MemoryService, "observe">;
  private readonly presence = new ConversationPresence();
  private readonly revisions = new Map<string, symbol>();
  private readonly onDelivered?: (message: FeishuInboundMessage, text: string) => void;

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
      /** 回复末尾是否显示模型统计小字（默认不显示）；工具过程状态不受影响 */
      showModelStats?: boolean;
      /** 回复文字是否允许 emoji（默认否：系统提示已禁用，发送前再兜底剥离） */
      replyEmoji?: boolean;
      /** 模型信息提供器（/model 指令展示用）；返回运行中的实时值 */
      modelInfo?: () => { baseUrl?: string; modelName: string; apiKey: string };
      /** 预制人员名单（可选）：按名字提到的人自动补 open_id 提示 */
      peopleRoster?: PeopleRoster;
      botOpenId?: string;
      recordSticker?: (chatId: string, id: string, line: string) => Promise<void>;
      /** 文字回答兜底：等待选项卡作答期间用户直接发文本也算回答；返回 true 表示已消费 */
      answerAskText?: (openId: string, chatId: string, text: string) => boolean;
      /** 每轮开始回调（用于重置单轮工具调用计数） */
      onRoundStart?: (chatId: string) => void;
      /** 轻量长期记忆（可选）：注入自我记忆与该用户的印象 */
      memory?: Pick<MemoryService, "observe">;
      onDelivered?: (message: FeishuInboundMessage, text: string) => void;
    },
  ) {
    this.conversations = conversations;
    this.transport = transport;
    this.onEvent = options?.onEvent;
    this.messages = options?.messages;
    this.client = options?.client;
    this.showModelStats = options?.showModelStats ?? false;
    this.replyEmoji = options?.replyEmoji ?? true;
    this.peopleRoster = options?.peopleRoster;
    this.botOpenId = options?.botOpenId;
    this.recordSticker = options?.recordSticker;
    this.answerAskText = options?.answerAskText;
    this.onRoundStart = options?.onRoundStart;
    this.memory = options?.memory;
    this.onDelivered = options?.onDelivered;
    // 不在对方消息上加表情：真人聊天不会每句话都贴一个 reaction。
    // 机制保留，需要时把第二个参数改成 true 即可启用。
    this.reactionController = options?.client ? new ReactionController(options.client, false) : undefined;
    this.commandRegistry = createDefaultRegistry(options?.modelInfo);
    // /detail on|off 设置详细/精简模式，状态由 bridge 持有（按 chatId 记忆，默认精简）
    this.commandRegistry.register(new DetailCommand(
      (chatId: string, enabled: boolean) => this.detailMode.set(chatId, enabled),
      (chatId: string) => this.detailMode.get(chatId) === true,
    ));
    // /new /stop 操作会话，实际逻辑由指令自身完成（见 commands.ts）；/restart 由 main 注入。
    this.commandRegistry.register(new NewCommand(async (id, openId) => {
      await this.conversations.reset(id, openId);
      this.presence.clear(id);
    }));
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
    const conversationId = message.context.conversationId;
    const userName = message.context.userName;
    const requestStartedAt = Date.now();
    const revision = Symbol(conversationId);
    this.revisions.set(conversationId, revision);
    const isCurrent = () => this.revisions.get(conversationId) === revision;

    // 新一轮开始：重置单轮工具调用预算（指令/文字回答路径也不受上一轮残留影响）
    this.onRoundStart?.(message.chatId);

    // 检测是否为指令
    const commandHandler = message.context.isOwner === true ? this.commandRegistry.find(message.text) : undefined;
    if (commandHandler) {
      await this.handleCommand(message, commandHandler);
      if (isCurrent()) this.revisions.delete(conversationId);
      return;
    }

    // 待答提问优先接收文字回答（AskBroker 兜底）：命中即消费，不进模型
    if (this.answerAskText?.(message.context.userOpenId, message.chatId, message.text)) {
      logger.info(`[Bridge] 提问已由文字回答结算: ${conversationId}`);
      if (isCurrent()) this.revisions.delete(conversationId);
      return;
    }

    const rosterHits = message.context.isOwner === true ? await this.peopleRoster?.match(message.text, { senderOpenId: message.context.userOpenId }).catch(() => []) ?? [] : [];
    const knownPeople = (message.people ?? []).filter((person) => person.openId !== this.botOpenId);
    if (!knownPeople.some((item) => item.openId === message.context.userOpenId)) {
      knownPeople.push({ openId: message.context.userOpenId, name: userName || message.context.userOpenId });
    }
    for (const person of rosterHits) {
      if (person.openId === this.botOpenId) continue;
      if (!knownPeople.some((item) => item.openId === person.openId)) {
        knownPeople.push({ openId: person.openId, name: person.name || person.enName });
      }
    }

    // 添加随机表情 reaction
    await this.reactionController?.start(message.messageId, message.text);

    if (!this.client) {
      throw new Error("client 未配置，无法创建 CardKit 回复");
    }

    const replyInThread = resolveReplyInThread(message.context.chatMode, message.context.threadId);
    const reply = new CardKitReply({
      client: this.client,
      chatId: message.chatId,
      messageId: message.messageId,
      replyInThread,
      onError: (err) => logger.error("[CardKit]", err),
      fallbackNotice: async () => {
        await this.client!.im.message.reply({
          path: { message_id: message.messageId },
          data: {
            msg_type: "text",
            content: JSON.stringify({ text: "卡片发送失败，请重试。" }),
            reply_in_thread: replyInThread,
          },
        });
      },
    });

    // 定时器句柄提级声明：无论 prompt 成功或抛错，finally 都要清掉，避免句柄泄漏
    let toolTimer: NodeJS.Timeout | undefined;
    // 工具段延迟上屏句柄：快速工具（<1s 完成）不展示，避免快速指令来回刷屏
    let pendingToolTimer: NodeJS.Timeout | undefined;
    const stickerDelivery = new StickerDelivery();
    const deliveredParts: string[] = [];
    let deliveredCardText = "";

    try {
      let hasRealContent = false;
      let textEvents = 0;
      let lastTextLength = -1;
      // 短回复先只缓冲文本，终态再决定发几条普通消息；工具段或长内容才切卡片。
      let bufferedText = "";
      let cardMode = false;
      let session: FeishuPiSession | undefined;

      // parts 模型（见 reply-parts.ts）：精简模式滚动回收，终态只留最后工具段之后的结论
      const replyParts = new ReplyParts(
        { render: (text) => reply.replace(text), append: (text) => reply.update(text) },
        () => this.detailMode.get(message.chatId) !== true,
      );

      // 「先不响应，有结果再回」：思考期不出卡、不写字，reaction 是唯一的收到信号；
      // 卡片延迟到首个真实内容（正文 / 满 1s 的工具段）写入时才创建。
      // 本轮是否被打断：结算时据此撤回复卡或定格中止说明（而不是渲染半截内容+统计）
      let interruptedByNewMessage = false;
      // 打断原因：new-message（收尾超时）→ 已出卡则定格说明；stop/reset → 撤卡
      let interruptedReason: InterruptReason | undefined;

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

      // 首个真实内容（正文或满 1s 仍在跑的工具段）到达时置位；卡片自此才开始创建
      let startedRealContent = false;
      const startRealContent = () => {
        if (startedRealContent) return;
        startedRealContent = true;
        hasRealContent = true;
      };

      // 历史里只留人话：`名字: 正文`。ID、通道、机器人显示名都不再每轮注入——
      // 只有正文里真的出现 @ 时，才把可 @ 的人名与 open_id 交给模型。
      // 资料查询失败时不要把 open_id 当人名塞给模型，否则它会追问「哪位」。
      const displayName = userName?.trim();
      const speaker = displayName && !/^ou_[A-Za-z0-9_-]+$/.test(displayName)
        ? displayName
        : message.context.isOwner
          ? "哥哥"
          : message.context.chatMode === "p2p" ? "对方" : "群友";
      const needsMention = /<at\b|@[_a-zA-Z]/.test(message.text);
      const body = needsMention ? annotatePeople(message.text, knownPeople) : message.text;
      const roster = needsMention
        ? knownPeople
            .filter((person) => person.name && person.name !== person.openId)
            .map((person) => `${person.name}(${person.openId})`)
            .join("、")
        : "";
      const promptText = [
        message.quoteText,
        `${speaker}: ${body}`,
        roster && `本轮可 @ 的人：${roster}`,
      ].filter(Boolean).join("\n");

      session = await this.conversations.prompt(
        {
          conversationId,
          prompt: { text: promptText, memoryText: message.text, turnContext: this.presence.recall(conversationId), images: message.images },
          context: message.context, // 调用者身份（权限组判定、会话目录归属的依据）
        },
        async (event) => {
          stickerDelivery.observe(event);
          await this.onEvent?.(event, message);
          if (event.type === "assistant_text") {
            textEvents += 1;
            lastTextLength = event.text.length;
            bufferedText = event.text;
            // 已切卡片就继续流式渲染；否则只缓冲，避免短回复也弹一整张卡。
            if (cardMode) await replyParts.appendText(event.text);
          }
          // 工具事件：追加工具摘要段（精简模式只留当前一个），小字位置同步显示动画。
          // 工具段延迟 1s 上屏：跑得比 1s 快的工具（快速指令）什么都不显示，不刷屏；
          // 满 1s 仍在运行才追加代码块并启动小字动画。
          if (event.type === "tool_started") {
            // 工具启动不再触发建卡：延迟满 1s 仍未完成才随工具段一起出卡（快速指令完全静默）
            const toolName = event.toolName;
            // 表情工具永远不弹卡片：图要像群友一样直接甩到聊天里，检索/审核过程不展示。
            if (toolName === "sticker_search" || toolName === "sticker_send") return;
            const segment = `\n\n${formatToolCall(toolName, event.args)}`;
            clearTimeout(pendingToolTimer);
            pendingToolTimer = setTimeout(() => {
              pendingToolTimer = undefined;
              activeToolName = toolName;
              toolSpinner.withPrefix(`${toolIcon(toolName)} ${toolName}`);
              void (async () => {
                // 慢工具才出卡：先把已缓冲的正文补进卡片，再追加工具段，保持阅读顺序。
                cardMode = true;
                startRealContent();
                if (bufferedText.trim()) await replyParts.appendText(bufferedText);
                await replyParts.appendTool(segment);
              })().catch(() => {});
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
              // 清成占位字符（不可见但保留行高）：状态栏恒定存在，不因空内容塌陷跳动
              await reply.updateStats(STATS_PLACEHOLDER);
            }
          }
        },
        (reason) => {
          interruptedByNewMessage = true;
          interruptedReason = reason;
        },
      );

      // 确保停止动画（在途帧先落定：避免迟到的动画帧盖过 close 写入的最终统计小字）
      clearInterval(toolTimer);
      await pendingToolFrameWrite;

      // 本轮被打断：新消息打断（收尾超时）且已出卡 → 定格中止说明留痕；
      // /stop、/new 或从未出卡（惰性建卡，close 会凭空建卡）→ 撤回（静默）
      if (interruptedByNewMessage) {
        if (interruptedReason === "new-message" && reply.isCreated) {
          await reply.close(INTERRUPT_NOTICE).catch((error) => logger.warn("[Bridge] 写入中止说明失败:", error));
          logger.info(`[Bridge] 本轮被新消息打断，回复卡已定格中止说明: ${conversationId}`);
        } else {
          await reply.recall().catch((error) => logger.warn("[Bridge] 撤回被打断的回复卡失败:", error));
          logger.info(`[Bridge] 本轮被打断（${interruptedReason ?? "unknown"}），回复卡已撤回: ${conversationId}`);
        }
        await this.messages?.complete(message.messageId);
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

      // 终态：详细=全量；精简=最后一个工具段之后的结论段。
      // 关闭 emoji 时发送前兜底剥离：提示层已约束模型，这里防偶发不听话（代码块内容不动）
      const composed = cardMode ? replyParts.composeFinal() : bufferedText;
      let finalText = this.replyEmoji ? composed : stripEmoji(composed);
      const sentStandaloneSticker = stickerDelivery.standaloneSent;
      // 本轮已经单独发过表情：只删明确的解说腔（描述图片、汇报张数、翻库存），
      // 正常接话不管长短都保留。
      if (sentStandaloneSticker) finalText = stripStickerCommentary(finalText);
      const useCard = cardMode || shouldUseCard(finalText);
      // 光发图：本轮以 standalone 表情作为整轮回复且无正文 → 不额外发文字，会话里只留那张图
      if (sentStandaloneSticker && !finalText.trim()) {
        await reply.recall().catch((error) => logger.warn("[Bridge] 撤回纯表情回复卡失败:", error));
      } else if (!useCard) {
        // 轻量闲聊：拆成几条普通文本消息，带一点打字等待，像人一条条发。
        await sendHumanReply(this.client, { chatId: message.chatId, messageId: message.messageId, text: finalText, replyInThread,
          shouldContinue: isCurrent, onDelivered: part => deliveredParts.push(part),
        });
      } else {
        await reply.close(finalText, statsLine);
        if (reply.isDelivered) deliveredCardText = finalText;
      }

      // 记录最终响应（含耗时；空文本单独特警，便于发现模型无输出/被拦截的情况；
      // standalone 表情的空正文是预期路径，不计入特警）
      const replyPreview: string = formatLogText(finalText) || (sentStandaloneSticker ? "[独立表情图，无正文]" : "");
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
      if (isCurrent()) this.revisions.delete(conversationId);
      // 动画定时器兜底清理（prompt 抛错时走这里；已清理过的句柄重复 clear 是无害的）
      clearInterval(toolTimer);
      clearTimeout(pendingToolTimer);
      // One settlement path for success, interruption and partial text delivery.
      const deliveredText = deliveredCardText || deliveredParts.join("\n\n");
      if (deliveredText || stickerDelivery.standaloneSent) {
        this.presence.delivered(conversationId, deliveredText, stickerDelivery.standaloneSent);
        try { this.onDelivered?.(message, deliveredText || "[已发送表情图片]"); }
        catch (error) { logger.warn("[Bridge] 更新群活动失败:", error instanceof Error ? error.message : error); }
        void this.memory?.observe({
          openId: message.context.userOpenId,
          context: { chatId: message.chatId, chatMode: message.context.chatMode ?? "group", threadId: message.context.threadId },
          userText: message.text, assistantText: deliveredText,
        }).catch(error => logger.warn("[Memory] 记录失败:", error instanceof Error ? error.message : error));
      }
      if (this.recordSticker) {
        await stickerDelivery.confirm(deliveredText, (id, line) => this.recordSticker!(message.chatId, id, line))
          .catch(error => logger.warn("[Sticker] 更新发送记录失败:", error instanceof Error ? error.message : error));
      }
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

      const result = await handler.execute(message, this.client);
      if (!result) {
        await this.messages?.complete(message.messageId);
        return;
      }

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
