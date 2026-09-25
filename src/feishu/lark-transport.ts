import { EventDispatcher, LoggerLevel, normalize, normalizeCardAction, WSClient, type Client, type NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { FeishuInboundMessage, FeishuTransport } from "./types.ts";
import { LarkCli } from "./lark-cli.ts";
import { LarkImageProcessor } from "./image-processor.ts";
import { MessageStore } from "./message-store.ts";
import { formatLogText } from "./log-utils.ts";
import { logger } from "../utils/logger.ts";
import { attachmentsDirOfSession, imagesDirOfSession, sanitizeFileName } from "../utils/session-paths.ts";
import { upsertEnvLine } from "../utils/env-file.ts";
import { toBuffer } from "./resource-buffer.ts";
import { mentionedUserIds } from "./people-roster.ts";
import { cardMentionIds, cardMentionNames, cardReferenceId, cardVisibleText, expandCardMentions, personLabel, postAttachments, speechText, type InboundResource } from "./inbound-content.ts";
import { transcribeAudio, type AudioTranscriptionOptions } from "./audio-transcriber.ts";
import { SessionStore } from "../runtime/session-store.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** 卡片回调的统一参数：按钮 value 载荷 + 回调来源（卡片消息与点击者） */
export interface CardCallbackParams {
  /** 按钮 behaviors.value 载荷（action/qid/token/decision 等，结构随卡片而定） */
  value: Record<string, unknown>;
  /** 回调来源：被点击的卡片消息 ID、所在会话与点击者 */
  action: { messageId: string; chatId: string; operatorOpenId: string; operatorName?: string };
}

/** 会话模式缓存条目上限（超出驱逐最久未用） */
const CHAT_MODE_CACHE_MAX = 500;

interface FetchedMessageItem {
  message_id?: string;
  msg_type?: string;
  parent_id?: string;
  create_time?: string;
  body?: { content?: string };
  sender?: { id?: string; sender_type?: string };
  mentions?: Array<{ key: string; name?: string; id?: { open_id?: string } }>;
}

export interface LarkTransportConfig {
  appId: string;
  appSecret: string;
  botOpenId?: string;
  botName?: string;
  source?: string;
  userProfileDir?: string;
  handshakeTimeoutMs?: number;
  pingTimeout?: number;
  /** 飞书 Client 实例（消息发送、卡片更新、资源下载等 API 调用） */
  client: Client;
  /** 会话注册表：一次会话一个目录，图片/附件全部落在那里面 */
  sessions: SessionStore;
  /** 管理员 Open ID（可选） */
  adminOpenId?: string;
  /** 仅在真实 @ 提及时自动查询被 @ 者；该通道不暴露给 Agent。 */
  searchMentionedUserProfile?: (mentionedOpenId: string) => Promise<{ name?: string; en_name?: string; department_name?: string[] } | undefined>;
  /** 单个资源和单条消息资源总大小限制 */
  maxResourceBytes?: number;
  maxMessageResourceBytes?: number;
  audioTranscription?: AudioTranscriptionOptions;
  /** 消息处理状态持久化，用于在预处理前去重 */
  messages?: MessageStore;
  /** 模型切换回调（/model 指令确认后触发，用于运行时热切换） */
  onModelSwitch?: (modelName: string) => void;
}

/**
 * 基于飞书官方底层 WSClient + EventDispatcher 的消息传输实现。
 *
 * 不使用 LarkChannel 高层封装——它对卡片回调有两个问题：
 *  1. 分发时丢弃 handler 返回值，ACK 帧没有数据体，客户端弹「目标回调服务超时未响应」
 *  2. 去重层对 10 分钟内重复点击静默吞事件（连 ACK 都不发）
 * 底层方式下 handler 返回值原样进 ACK（与 Go 官方 SDK 行为一致），
 * 消息去重由传输层在预处理前调用 MessageStore.claim 保证，会话内顺序由 ConversationManager 保证。
 */
export class LarkTransport implements FeishuTransport {
  private wsClient?: WSClient;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly botOpenId?: string;
  private readonly botName: string;
  private readonly source: string;
  private readonly handshakeTimeoutMs: number;
  private readonly pingTimeout: number;
  private readonly larkCli: LarkCli;
  private readonly imageProcessor?: LarkImageProcessor;
  private readonly adminOpenId?: string;
  private readonly searchMentionedUserProfile?: LarkTransportConfig["searchMentionedUserProfile"];
  private readonly mentionLookupInflight = new Map<string, Promise<void>>();
  private readonly failedSenderLookups = new Map<string, number>();
  private readonly onModelSwitch?: (modelName: string) => void;
  private readonly client: Client;
  private handler?: (message: FeishuInboundMessage) => Promise<void>;
  private approvalHandler?: (params: CardCallbackParams) => Promise<void>;
  private askHandler?: (params: CardCallbackParams) => Promise<void>;
  private connecting?: Promise<void>;
  /** 会话模式缓存（p2p/group/topic），话题群与普通群的会话隔离策略不同 */
  private readonly chatModeCache = new Map<string, "p2p" | "group" | "topic">();
  private readonly sessions: SessionStore;
  private readonly messages?: MessageStore;
  private readonly maxResourceBytes: number;
  private readonly maxMessageResourceBytes: number;
  private readonly audioTranscription?: AudioTranscriptionOptions;

  constructor(config: LarkTransportConfig) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.botOpenId = config.botOpenId;
    this.botName = config.botName || "机器人";
    this.source = config.source ?? "feishu-pi";
    this.handshakeTimeoutMs = config.handshakeTimeoutMs ?? 15_000;
    this.pingTimeout = config.pingTimeout ?? 30;
    this.adminOpenId = config.adminOpenId;
    this.searchMentionedUserProfile = config.searchMentionedUserProfile;
    this.onModelSwitch = config.onModelSwitch;
    this.client = config.client;
    this.sessions = config.sessions;
    this.messages = config.messages;
    this.maxResourceBytes = config.maxResourceBytes ?? 20 * 1024 * 1024;
    this.maxMessageResourceBytes = config.maxMessageResourceBytes ?? this.maxResourceBytes * 2;
    this.audioTranscription = config.audioTranscription;
    this.larkCli = new LarkCli(config.appId, config.userProfileDir);
    this.imageProcessor = new LarkImageProcessor(config.client, {
      maxResourceBytes: this.maxResourceBytes,
      maxMessageResourceBytes: this.maxMessageResourceBytes,
    });
  }

  /** 建立飞书长连接并开始接收事件。 */
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.wsClient) return; // 已连接（WSClient 自带重连，无需重复 start）

    const dispatcher = new EventDispatcher({
      // dispatcher 自带 tslog 默认 logger（格式是 "fo]: [...]" 那种且不受 Client 的 loggerLevel 控制）：
      // 注入转发实现——SDK 的启动/运行信息（如 "event-dispatch is ready"）用项目格式正常打印
      logger: {
        info: (data: unknown) => logger.info(`[LarkTransport] ${typeof data === "string" ? data : JSON.stringify(data)}`),
        debug: () => {},
        warn: (data: unknown) => logger.warn(`[LarkTransport] ${typeof data === "string" ? data : JSON.stringify(data)}`),
        error: (data: unknown) => logger.error(`[LarkTransport] ${typeof data === "string" ? data : JSON.stringify(data)}`),
      } as never,
    });
    dispatcher.register({
      // 未使用的事件注册空处理器：避免 SDK 对每个未订阅事件打 "no xxx handle" 无上下文警告
      "im.chat.member.bot.added_v1": async () => {},
      "im.message.reaction.created_v1": async () => {},
      "im.message.reaction.deleted_v1": async () => {},
      "im.message.message_read_v1": async () => {},
      // 普通消息：normalize 归一化（content/resources/mentions），交给 handler 后台处理
      "im.message.receive_v1": async (raw: Record<string, unknown>) => {
        try {
          const rawMessage = raw.message as { chat_type?: string; mentions?: Array<{ id?: { open_id?: string } }> } | undefined;
          if (rawMessage?.chat_type === "group" && this.botOpenId &&
              !rawMessage.mentions?.some((mention) => mention.id?.open_id === this.botOpenId)) return;
          const forwardedNames = new Map<string, string>();
          const message = await normalize(raw as never, {
            botIdentity: this.botOpenId ? { openId: this.botOpenId } : undefined,
            stripBotMentions: true,
            includeRaw: true,
            fetchSubMessages: async (messageId: string) => await this.getMessageItems(messageId) as never,
            batchResolveNames: async (ids: string[]) => await this.fillForwardedNames(ids, forwardedNames),
            resolveUserName: (id: string) => forwardedNames.get(id) || id,
          } as never);
          if (!message) return;
          await this.dispatchMessage(message);
        } catch (error) {
          logger.error("[LarkTransport] 消息归一化/分发失败:", error);
        }
      },
      // 卡片回调：handler 返回值（toast）会进 ACK 帧，反馈点击行为——不再弹「超时未响应」
      "card.action.trigger": async (raw: Record<string, unknown>) => {
        const evt = normalizeCardAction(raw as object, { includeRaw: true });
        if (evt) {
          void this.handleCardAction(evt).catch((error) => logger.error("[CardAction] 处理卡片回调失败:", error));
        }
        return { toast: { type: "info", content: "✅ 已收到，处理中…" } };
      },
    });

    this.wsClient = new WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      source: this.source,
      loggerLevel: LoggerLevel.warn, // SDK 自己的 logger 格式与项目不一致；只在异常时出声
      handshakeTimeoutMs: this.handshakeTimeoutMs,
      wsConfig: { pingTimeout: this.pingTimeout },
      onReconnecting: () => logger.warn("[LarkTransport] 飞书 WebSocket 正在重连"),
      onReconnected: () => logger.info("[LarkTransport] 飞书 WebSocket 已恢复"),
      onError: (error: unknown) => logger.error("[LarkTransport] 飞书 WebSocket 错误", error),
    } as never);

    this.connecting = this.wsClient.start({ eventDispatcher: dispatcher as never }).then(() => {
      logger.info("[LarkTransport] 飞书 WebSocket 已连接");
      this.connecting = undefined;
    }).catch((error) => {
      // 首连失败必须清掉残留实例：否则后续 connect() 会被"已连接"短路，永久静默失联
      this.connecting = undefined;
      this.wsClient = undefined;
      throw error;
    });
    return this.connecting;
  }

  /**
   * 分发一条归一化后的消息给 handler。
   * 关键：不能 await 完整处理——若在此等待整个 Agent 流程（可能卡在等授权卡点击），
   * SDK 的事件处理会被阻塞。交给 handler 后台处理，
   * 会话内的顺序由 ConversationManager 保证，消息去重在附件预处理前完成。
   */
  private async dispatchMessage(message: NormalizedMessage): Promise<void> {
    if (this.botOpenId && message.senderId === this.botOpenId) return;
    const chatId = message.chatId;
    let claimed = false;
    let stopLease: (() => void) | undefined;
    try {
      // 会话模式先行：决定响应资格（群聊需 @）与 conversationId 归属
      const chatMode = await this.getChatModeCached(chatId, message.chatType);

      // 群聊/话题群只响应 @机器人 的消息；私聊全响应。
      // 未 @ 的消息静默忽略（不查资料、不入会话，避免群聊刷屏误触发）。
      if (chatMode !== "p2p" && !message.mentionedBot) return;

      claimed = this.messages ? await this.messages.claim(message.messageId) : true;
      if (!claimed) return;
      stopLease = this.messages?.startLease(message.messageId);

      // 会话 ID + 会话目录最先就位：消息一旦开始处理，
      // 归属与落盘位置即已确定（先于资料查询与模型思考）。
      // 会话目录由会话注册表给出（/new 之后拿到的是新会话目录）
      const threadId = message.threadId;
      const conversationId = buildConversationId(chatId, chatMode, threadId, message.messageId);
      const sessionDir = await this.sessions.dirFor(conversationId, message.senderId);

      let profile = await this.larkCli.getUserProfile(message.senderId);
      if (!profile.name && !profile.en_name) {
        await this.resolveSenderProfile(message.senderId);
        profile = await this.larkCli.getUserProfile(message.senderId);
      }
      const displayName = profile.name || profile.en_name || message.senderName || message.senderId;

      // 只对消息里真实 @ 的人使用固定资料查询，且在模型开始前等其完成。
      const mentionedIds = mentionedUserIds(message.mentions ?? [], message.senderId).filter((id) => id !== this.botOpenId);
      await Promise.all(mentionedIds.map((id) => this.resolveMentionProfile(id)));
      const people = await Promise.all(mentionedIds.map(async (openId) => {
        const saved = await this.larkCli.getUserProfile(openId);
        const raw = message.mentions.find((mention) => mention.openId === openId);
        return { openId, name: saved.name || saved.en_name || raw?.name || openId, alias: raw?.name };
      }));

      // SDK 默认把 @_user_1 压成 @名字，丢失 open_id；用已确认的人物资料重新归一化一次。
      const rawEvent = message.raw as { message?: { content?: string; mentions?: Array<{ key?: string; name?: string; id?: { open_id?: string } }> } } | undefined;
      let normalizedContent = message.content;
      if (rawEvent?.message?.mentions?.length) {
        const enrichedMentions = rawEvent.message.mentions.map((mention) => {
          const person = people.find((item) => item.openId === mention.id?.open_id);
          if (!person) return mention;
          const alias = mention.name || person.name;
          const name = alias === person.name ? personLabel(person.name, person.openId) : `${alias}(${person.name},${person.openId})`;
          return { ...mention, name };
        });
        const enriched = await normalize({ ...rawEvent, message: { ...rawEvent.message, mentions: enrichedMentions } } as never, {
          botIdentity: { openId: this.botOpenId || "", name: this.botName },
          stripBotMentions: true,
        });
        normalizedContent = enriched.content;
      }

      const rawContent = rawEvent?.message?.content || "";
      const messageType = message.rawContentType;
      const resources: InboundResource[] = [...message.resources, ...postAttachments(rawContent, messageType)];
      const uniqueResources = resources.filter((item, index) => item.fileKey && resources.findIndex((other) => other.type === item.type && other.fileKey === item.fileKey) === index);

      // 处理图片附件（含 post 富文本里的图片：SDK 会把它们放进 resources）
      let images;
      let imageCount = 0;
      let imageBytes = 0;
      let imageNotes: string[] = [];
      if (uniqueResources.length > 0) {
        const imageKeys = uniqueResources.filter((r) => r.type === "image").map((r) => r.fileKey);
        if (imageKeys.length > 0) {
          imageCount = imageKeys.length;
          const processed = await this.imageProcessor?.processImages(
            message.messageId,
            imageKeys,
            imagesDirOfSession(sessionDir),
          );
          if (processed && processed.length > 0) {
            // 图片 base64 不写入会话记录（易失内容不落盘，见 runtime 的 disableVolatilePersistence），
            // 这里把落盘路径写进消息文本，需要时可用 read 工具按路径取回原图
            imageNotes = processed.map((img) => img.savedPath).filter((p): p is string => !!p);
            images = processed;
            imageBytes = processed.reduce((sum, image) => sum + image.data.byteLength, 0);
          }
        }
      }

      // 过滤消息中的 @ 机器人标记（normalize 已按占位符替换，这里兜底清洗）
      let cleanedText = stripBotMentions(normalizedContent, this.botOpenId);
      if (messageType === "interactive") {
        const card = await this.fetchCardText(message.messageId, rawContent);
        if (card) {
          cleanedText = `[卡片内容]\n${card.text}`;
          for (const person of card.people) {
            if (!people.some((known) => known.openId === person.openId)) people.push({ ...person, alias: undefined });
          }
        }
      }
      let nativeTranscript: string | undefined;
      if (messageType === "audio") {
        let transcript = speechText(rawContent, messageType);
        if (!transcript) {
          const fetched = await this.getMessageItem(message.messageId).catch(() => undefined);
          transcript = speechText(fetched?.body?.content || "", messageType);
        }
        nativeTranscript = transcript;
        cleanedText = transcript ? `[语音转写] ${transcript}` : "[语音消息，飞书未提供转写]";
      }

      // 下载文件类附件（file/audio/video/media），保存到本会话目录的 files/ 并把路径写进消息文本，
      // Agent 可用 read/bash 直接访问
      {
        const attachmentNote = await downloadFileAttachments(
          attachmentsDirOfSession(sessionDir),
          uniqueResources,
          (fileKey, type) => this.downloadResource(message.messageId, fileKey, type),
          {
            maxResourceBytes: this.maxResourceBytes,
            maxTotalBytes: Math.max(0, this.maxMessageResourceBytes - imageBytes),
          },
          nativeTranscript ? undefined : async (data) => await transcribeAudio(data, this.audioTranscription ?? {}),
        );
        if (attachmentNote) {
          if (attachmentNote.includes("[语音转写]")) cleanedText = cleanedText.replace("[语音消息，飞书未提供转写]", "").trim();
          cleanedText += attachmentNote;
        }
      }

      if (imageNotes.length > 0) {
        // 图片本体不入会话记录，只留路径（与文件类附件的 [附件] 说明同格式）
        cleanedText += imageNotes.map((p) => `\n[图片] 已保存到: ${p}`).join("");
      }

      const quote = message.replyToMessageId
        ? await this.fetchQuotedContext(message.replyToMessageId, sessionDir).catch((error) => {
            logger.warn(`[LarkTransport] 引用消息读取失败 ${message.replyToMessageId}: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
          })
        : undefined;
      const quoteText = quote?.text ?? (message.replyToMessageId ? `[引用消息 ${message.replyToMessageId}：暂时无法读取原文]` : undefined);
      if (quote?.images.length) images = [...quote.images, ...(images ?? [])];

      // 记录收到的消息
      const imageInfo = imageCount > 0 ? `（含 ${imageCount} 张图片）` : "";
      logger.userInput(displayName, `: ${imageInfo}${formatLogText(cleanedText)}`);

      // 判断是否为管理员
      const isAdmin = this.adminOpenId ? message.senderId === this.adminOpenId : false;

      // fire-and-forget：后台处理，失败仅记日志
      const handler = this.handler;
      if (!handler) throw new Error("消息处理器未注册");
      void handler({
        messageId: message.messageId,
        chatId,
        context: {
          userOpenId: message.senderId,
          userName: displayName,
          en_name: profile.en_name || undefined,
          department_name: profile.department_name,
          chatId,
          threadId,
          chatMode,
          conversationId,
          isAdmin,
        },
        text: cleanedText,
        images,
        quoteText,
        people: [...people, ...(quote?.people ?? [])],
      }).catch((error) => {
        logger.error(`[LarkTransport] 消息处理失败: ${error instanceof Error ? error.message : error}`);
      }).finally(() => stopLease?.());
    } catch (error) {
      stopLease?.();
      // claim 成功但预处理失败时允许后续投递重试；AgentBridge 自己的失败路径仍负责标记 Agent 错误。
      if (claimed) await this.messages?.fail(message.messageId).catch(() => undefined);
      const detail = error instanceof Error ? error.message : String(error);
      logger.error(`[LarkTransport] 消息预处理失败: ${detail}`);
    }
  }

  /** 卡片回调的实际处理逻辑（后台执行）。 */
  private async handleCardAction(action: {
    messageId: string;
    chatId: string;
    operator: { openId: string; userId?: string; name?: string };
    action: { value: unknown; tag: string; name?: string; option?: string };
    raw?: unknown;
  }): Promise<void> {
    try {
      // 解析回调数据（value 可能是对象或 JSON 字符串）
      let value: Record<string, unknown> | string = action.action.value as never;
      if (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          logger.warn(`[CardAction] value 不是有效的 JSON: ${value}`);
        }
      }

      // 授权卡回调（授权/拒绝/申请转发）：交给 PermissionBroker 在服务端校验（含管理员身份）
      if (typeof value === "object" && (value?.action === "tool_approval" || value?.action === "forward_approval")) {
        await this.approvalHandler?.({
          value,
          action: {
            messageId: action.messageId,
            chatId: action.chatId,
            operatorOpenId: action.operator.openId,
            operatorName: action.operator.name,
          },
        });
        return;
      }

      // 选项卡回调（ask_user）：交给 AskBroker 校验（存在性/一次性 token/仅本人）
      if (typeof value === "object" && value?.action === "ask_user") {
        await this.askHandler?.({
          value,
          action: {
            messageId: action.messageId,
            chatId: action.chatId,
            operatorOpenId: action.operator.openId,
            operatorName: action.operator.name,
          },
        });
        return;
      }

      // 其余卡片（/model）：管理员校验后处理
      const operatorOpenId = action.operator.openId;
      const isAdmin = this.adminOpenId ? operatorOpenId === this.adminOpenId : false;

      if (!isAdmin) {
        logger.warn(`[CardAction] 非管理员点击卡片: ${operatorOpenId}`);
        await this.updateCard(action, {
          schema: "2.0",
          header: { title: { tag: "plain_text", content: "模型切换" } },
          body: { elements: [{ tag: "markdown", content: "❌ 仅管理员可执行此操作" }] },
        });
        return;
      }

      if (typeof value === "object" && value?.action === "switch_model") {
        logger.info(`[CardAction] 管理员切换模型: ${value.model_id}`);
        try {
          const modelName = typeof value.model_id === "string" ? value.model_id.trim() : "";
          if (!modelName || /[\r\n]/.test(modelName)) throw new Error("模型 ID 不合法");
          this.persistModelName(modelName);
          await this.updateCard(action, {
            schema: "2.0",
            header: { title: { tag: "plain_text", content: "模型切换结果" } },
            config: { update_multi: true },
            body: { elements: [{ tag: "markdown", content: `✅ 已切换到模型：${value.model_id}\n\n当前卡片已更新。` }] },
          });
          logger.info(`[CardAction] 卡片更新成功`);
        } catch (err) {
          logger.error(`[CardAction] 切换模型失败:`, err);
        }
      }
    } catch (error) {
      logger.error("[CardAction] 处理卡片回调失败:", error);
    }
  }

  /** 查询会话模式并缓存（话题群与普通群的会话隔离策略不同，模式极少变化）。
   *  缓存有上限（近似 LRU：超限驱逐最早条目），长驻进程不无限增长。 */
  private async getChatModeCached(chatId: string, eventChatType?: string): Promise<"p2p" | "group" | "topic"> {
    const cached = this.chatModeCache.get(chatId);
    if (cached) {
      // 命中时移到末尾，保证驱逐的是真正最久未用的条目
      this.chatModeCache.delete(chatId);
      this.chatModeCache.set(chatId, cached);
      return cached;
    }
    try {
      const res = await this.client.im.v1.chat.get({ path: { chat_id: chatId } });
      const mode = (res.data as { chat_mode?: string } | undefined)?.chat_mode;
      const result: "p2p" | "group" | "topic" = mode === "p2p" ? "p2p" : mode === "topic" ? "topic" : "group";
      this.chatModeCache.set(chatId, result);
      if (this.chatModeCache.size > CHAT_MODE_CACHE_MAX) {
        const oldest = this.chatModeCache.keys().next().value;
        if (oldest !== undefined) this.chatModeCache.delete(oldest);
      }
      return result;
    } catch (error) {
      const fallback = eventChatType === "p2p" ? "p2p" : "group";
      logger.warn(`[LarkTransport] 获取会话模式失败，按事件中的 ${fallback} 类型处理: ${error instanceof Error ? error.message : error}`);
      return fallback;
    }
  }

  /** 持久化模型配置并通知运行时热切换（供服务重启与当前进程同时生效）。 */
  private persistModelName(modelName: string): void {
    const envFile = join(process.cwd(), ".env");
    const updated = upsertEnvLine(readFileSync(envFile, "utf-8"), "FEISHU_PI_MODEL_NAME", modelName);
    writeFileSync(envFile, updated, "utf-8");
    this.onModelSwitch?.(modelName);
  }

  /**
   * 更新卡片。优先按 messageId 持久更新（im.v1.message.patch，实体变更）；
   * 失败时回退到卡片回调 token 的临时更新（仅本次点击视图可见）。
   */
  private async updateCard(action: { messageId: string; raw?: unknown }, card: object): Promise<void> {
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: action.messageId },
        data: { content: JSON.stringify(card) },
      });
      return;
    } catch (error) {
      logger.warn(`[LarkTransport] 按 messageId 更新卡片失败，回退 token 更新: ${error instanceof Error ? error.message : error}`);
    }

    const raw = action.raw as { token?: string } | undefined;
    if (raw?.token) {
      await this.client.request({
        method: "POST",
        url: "/open-apis/interactive/v1/card/update",
        data: { token: raw.token, card },
      });
    }
  }

  /**
   * 下载消息资源（image/file）为 Buffer（响应形态差异由 resource-buffer 收敛）。
   * 用户消息里的资源必须走「获取消息中的资源文件」接口（带 message_id），
   * /im/v1/images、/im/v1/files 只支持应用自己上传的资源。
   */
  private async downloadResource(messageId: string, fileKey: string, type: string): Promise<Buffer> {
    const res = await this.client.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: type === "image" ? "image" : "file" },
    });
    return toBuffer(res, this.maxResourceBytes);
  }

  /** 关闭飞书长连接。 */
  async disconnect(): Promise<void> {
    this.wsClient?.close();
  }

  onMessage(handler: (message: FeishuInboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  /** 注册授权卡片回调处理器（PermissionBroker 在服务端校验管理员身份）。 */
  onApproval(handler: (params: CardCallbackParams) => Promise<void>): void {
    this.approvalHandler = handler;
  }

  /** 注册选项卡回调处理器（AskBroker 校验存在性/一次性 token/仅本人）。 */
  onAskUser(handler: (params: CardCallbackParams) => Promise<void>): void {
    this.askHandler = handler;
  }

  /** 向指定会话发送一张卡片，返回 messageId。 */
  async sendCardToChat(chatId: string, card: object): Promise<string> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    const messageId = (res.data as { message_id?: string } | undefined)?.message_id;
    if (!messageId) throw new Error(`发送卡片失败：响应缺少 message_id`);
    return messageId;
  }

  /** 向指定用户私聊发卡片：receive_id_type=open_id，飞书自动投递到与该用户的会话
   *  （无需事先知道 oc_ 会话 ID；转发授权卡到管理员私聊用）。 */
  async sendCardToUser(openId: string, card: object): Promise<string> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: "open_id" },
      data: {
        receive_id: openId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    const messageId = (res.data as { message_id?: string } | undefined)?.message_id;
    if (!messageId) throw new Error(`发送卡片失败：响应缺少 message_id`);
    return messageId;
  }

  /** 发言人用机器人应用权限查询本人资料；管理员用户令牌只用于真实 @ 的固定入库流程。 */
  private async resolveSenderProfile(openId: string): Promise<void> {
    if (!/^ou_[A-Za-z0-9_-]+$/.test(openId)) return;
    if ((this.failedSenderLookups.get(openId) ?? 0) > Date.now()) return;
    try {
      const response = await this.client.request({
        method: "GET",
        url: `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`,
        params: { user_id_type: "open_id" },
      }) as { code?: number; data?: { user?: { name?: string; en_name?: string } } };
      const user = response.data?.user;
      if (response.code === 0 && user && (user.name || user.en_name)) {
        await this.larkCli.putProfile(openId, user);
      } else {
        this.failedSenderLookups.set(openId, Date.now() + 60 * 60_000);
      }
    } catch (error) {
      this.failedSenderLookups.set(openId, Date.now() + 60 * 60_000);
      logger.warn(`[LarkTransport] 发言人资料读取失败 ${openId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async resolveMentionProfile(openId: string): Promise<void> {
    const existing = this.mentionLookupInflight.get(openId);
    if (existing) return existing;
    const task = (async () => {
      const cached = await this.larkCli.getUserProfile(openId);
      const ageMs = Date.now() - Date.parse(cached.updatedAt);
      if ((cached.name || cached.en_name || cached.department_name.length) && ageMs < 3 * 24 * 60 * 60_000) return;
      const found = await this.searchMentionedUserProfile?.(openId);
      if (found) await this.larkCli.putProfile(openId, found);
    })().catch((error) => logger.warn(`[LarkTransport] @ 用户资料补全失败 ${openId}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.mentionLookupInflight.delete(openId));
    this.mentionLookupInflight.set(openId, task);
    return task;
  }

  /** 合并转发里的每条发言也标注姓名和 ID，使用机器人应用权限查询。 */
  private async fillForwardedNames(ids: string[], names: Map<string, string>): Promise<void> {
    const unique = [...new Set(ids)].slice(0, 50);
    for (let index = 0; index < unique.length; index += 5) {
      await Promise.all(unique.slice(index, index + 5).map(async (id) => {
        if (id.startsWith("ou_")) await this.resolveSenderProfile(id);
        const profile = id.startsWith("ou_") ? await this.larkCli.getUserProfile(id) : undefined;
        names.set(id, personLabel(profile?.name || profile?.en_name || (id === this.appId || id === this.botOpenId ? this.botName : undefined), id));
      }));
    }
  }

  /** 卡片 2.0 的事件内容常是 card_id 引用；按消息 ID 向飞书取可读原卡。 */
  private async fetchCardText(messageId: string, fallbackContent: string): Promise<{ text: string; people: Array<{ openId: string; name: string }> } | undefined> {
    let content = fallbackContent;
    let item: FetchedMessageItem | undefined;
    try {
      item = await this.getMessageItem(messageId, "user_card_content");
      content = item?.body?.content || content;
    } catch (error) {
      logger.warn(`[LarkTransport] 卡片原文读取失败 ${messageId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let text = cardVisibleText(content);
    const cardId = cardReferenceId(content);
    if (!text && cardId && /^[A-Za-z0-9_-]+$/.test(cardId)) {
      try {
        const response = await this.client.request({ method: "GET", url: `/open-apis/cardkit/v1/cards/${cardId}` }) as { data?: { card?: unknown } };
        text = cardVisibleText(JSON.stringify(response.data?.card ?? response.data ?? {}));
      } catch (error) {
        logger.warn(`[LarkTransport] CardKit 内容读取失败 ${cardId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!text) return undefined;
    const names = cardMentionNames(content);
    for (const mention of item?.mentions ?? []) {
      const id = mention.id?.open_id;
      if (id && id !== this.botOpenId && mention.name) names.set(id, mention.name);
    }
    const ids = cardMentionIds(text, this.botOpenId);
    for (let index = 0; index < ids.length; index += 5) {
      await Promise.all(ids.slice(index, index + 5).map(async (id) => {
        const cached = await this.larkCli.getUserProfile(id);
        if (!cached.name && !cached.en_name && !names.has(id)) {
          await this.resolveSenderProfile(id);
        }
        const profile = await this.larkCli.getUserProfile(id);
        const name = profile.name || profile.en_name;
        if (name) names.set(id, name);
      }));
    }
    return {
      text: expandCardMentions(text, names, this.botOpenId),
      people: ids.map((openId) => ({ openId, name: names.get(openId) || openId })),
    };
  }

  private async getMessageItem(messageId: string, cardContentType = "raw_card_content"): Promise<FetchedMessageItem | undefined> {
    return (await this.getMessageItems(messageId, cardContentType))[0];
  }

  private async getMessageItems(messageId: string, cardContentType = "raw_card_content"): Promise<FetchedMessageItem[]> {
    if (!/^om_[A-Za-z0-9_-]+$/.test(messageId)) return [];
    const response = await this.client.request({
      method: "GET",
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      params: { card_msg_content_type: cardContentType },
    }) as { code?: number; data?: { items?: FetchedMessageItem[] } };
    if (response.code !== 0) throw new Error(`消息读取失败：${response.code ?? "无响应码"}`);
    return response.data?.items ?? [];
  }

  /** 引用链最多读取三层；每层保留自己的发言人、类型和可见内容。 */
  private async fetchQuotedContext(parentId: string, sessionDir: string): Promise<{ text: string; images: NonNullable<FeishuInboundMessage["images"]>; people: NonNullable<FeishuInboundMessage["people"]> } | undefined> {
    const lines: string[] = [];
    const images: NonNullable<FeishuInboundMessage["images"]> = [];
    const people: NonNullable<FeishuInboundMessage["people"]> = [];
    const visited = new Set<string>();
    let current = parentId;
    for (let depth = 0; depth < 3 && current && !visited.has(current); depth++) {
      visited.add(current);
      const item = await this.getMessageItem(current).catch((error) => {
        logger.warn(`[LarkTransport] 引用第 ${depth + 1} 层读取失败 ${current}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
      if (!item) break;
      const senderId = item.sender?.id || "未知ID";
      const senderType = item.sender?.sender_type;
      if (senderType !== "app" && senderId.startsWith("ou_")) await this.resolveSenderProfile(senderId);
      const profile = senderType === "app" ? undefined : await this.larkCli.getUserProfile(senderId);
      const senderName = senderType === "app"
        ? senderId === this.appId || senderId === this.botOpenId ? this.botName : "其他机器人"
        : profile?.name || profile?.en_name || senderId;
      if (senderId.startsWith("ou_") && !people.some((person) => person.openId === senderId)) {
        people.push({ openId: senderId, name: senderName });
      }
      const type = item.msg_type || "text";
      const rawContent = item.body?.content || "";
      const mentions = await Promise.all((item.mentions || []).map(async (mention) => {
        const openId = mention.id?.open_id;
        if (!openId || !openId.startsWith("ou_") || openId === this.botOpenId) return mention;
        const saved = await this.larkCli.getUserProfile(openId);
        const name = saved.name || saved.en_name || mention.name || openId;
        if (!people.some((person) => person.openId === openId)) people.push({ openId, name, alias: mention.name });
        return { ...mention, name: personLabel(name, openId) };
      }));
      const forwardedNames = new Map<string, string>();
      const synthetic = await normalize({
        sender: { sender_id: { open_id: senderId } },
        message: {
          message_id: current,
          chat_id: "quote",
          chat_type: "group",
          message_type: type,
          content: rawContent,
          mentions,
        },
      } as never, {
        botIdentity: { openId: this.botOpenId || "", name: this.botName },
        stripBotMentions: false,
        fetchSubMessages: async (id: string) => await this.getMessageItems(id) as never,
        batchResolveNames: async (ids: string[]) => await this.fillForwardedNames(ids, forwardedNames),
        resolveUserName: (id: string) => forwardedNames.get(id) || id,
      } as never);
      const quotedCard = type === "interactive" ? await this.fetchCardText(current, rawContent) : undefined;
      for (const person of quotedCard?.people ?? []) {
        if (!people.some((known) => known.openId === person.openId)) people.push(person);
      }
      let body = quotedCard?.text;
      body ||= speechText(rawContent, type) || synthetic.content;
      if (type === "audio" && !speechText(rawContent, type)) {
        const audioKey = synthetic.resources.find((resource) => resource.type === "audio")?.fileKey;
        if (audioKey) {
          try {
            const audio = await this.downloadResource(current, audioKey, "audio");
            const transcript = await transcribeAudio(audio, this.audioTranscription ?? {});
            if (transcript) body = `[语音转写] ${transcript}`;
          } catch (error) {
            logger.warn(`[LarkTransport] 引用语音转写失败 ${current}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      const imageKeys = synthetic.resources.filter((resource) => resource.type === "image").map((resource) => resource.fileKey);
      if (imageKeys.length && images.length < 10) {
        const processed = await this.imageProcessor?.processImages(current, imageKeys.slice(0, 10 - images.length), imagesDirOfSession(sessionDir));
        if (processed) {
          images.push(...processed);
          body += processed.map((image) => image.savedPath ? `\n[引用图片] 已保存到: ${image.savedPath}` : "\n[引用图片]").join("");
        }
      }
      const attachmentNote = await downloadFileAttachments(
        attachmentsDirOfSession(sessionDir),
        synthetic.resources,
        (key, resourceType) => this.downloadResource(current, key, resourceType),
        { maxResourceBytes: this.maxResourceBytes, maxTotalBytes: this.maxMessageResourceBytes },
      ).catch((error) => {
        logger.warn(`[LarkTransport] 引用附件保存失败 ${current}: ${error instanceof Error ? error.message : String(error)}`);
        return "";
      });
      body += attachmentNote;
      lines.unshift(`[引用 ${depth + 1}] ${personLabel(senderName, senderId)}: ${body}`);
      current = item.parent_id || "";
    }
    return lines.length ? { text: lines.join("\n"), images, people } : undefined;
  }

  /** 登录绑定：把身份 API 给出的权威姓名直接写入用户资料缓存（冷却空档案立即被覆盖）。 */
  seedUserProfile(openId: string, profile: { name?: string; en_name?: string }): Promise<void> {
    return this.larkCli.putProfile(openId, profile);
  }

  /** 按 messageId 更新已发送的卡片。 */
  async updateCardById(messageId: string, card: object): Promise<void> {
    await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  }

  /** 按 messageId 撤回消息。 */
  async recallMessageById(messageId: string): Promise<void> {
    await this.client.im.v1.message.delete({ path: { message_id: messageId } });
  }

  /** 以文本形式向会话发送错误提示。 */
  async sendTextToChat(chatId: string, text: string): Promise<void> {
    await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    });
  }

  /** 以文本私聊指定用户；飞书按 open_id 自动投递到机器人与该用户的会话。 */
  async sendTextToUser(openId: string, text: string): Promise<void> {
    await this.client.im.v1.message.create({
      params: { receive_id_type: "open_id" },
      data: { receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) },
    });
  }
}

/**
 * 下载文件类附件（file/audio/video/media）到本会话目录的 files/ 子目录
 * （`{会话目录}/files/`），返回要追加到消息文本的附件说明（无附件时为空串）。
 *
 * 文件名带时间戳 + 随机前缀，同一会话先后传同名文件不互相覆盖；单个下载失败只记 warn，不影响其余附件。
 */
export async function downloadFileAttachments(
  targetDir: string,
  resources: ReadonlyArray<{ type: string; fileKey: string; fileName?: string }>,
  download: (fileKey: string, type: string) => Promise<Buffer>,
  limits: { maxResourceBytes: number; maxTotalBytes: number } = {
    maxResourceBytes: 20 * 1024 * 1024,
    maxTotalBytes: 40 * 1024 * 1024,
  },
  transcribe?: (data: Buffer, fileName: string) => Promise<string | undefined>,
): Promise<string> {
  const fileResources = resources.filter((r) => ["file", "audio", "video", "media"].includes(r.type) && r.fileKey);
  if (fileResources.length === 0) return "";

  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(targetDir, { recursive: true });

  let attachmentNote = "";
  let totalBytes = 0;
  for (const resource of fileResources.slice(0, 5)) {
    try {
      const buffer = await download(resource.fileKey, resource.type);
      if (buffer.length > limits.maxResourceBytes) {
        throw new Error(`附件超过单文件大小限制（${limits.maxResourceBytes} 字节）`);
      }
      if (totalBytes + buffer.length > limits.maxTotalBytes) {
        throw new Error(`附件超过单条消息总大小限制（${limits.maxTotalBytes} 字节）`);
      }
      const fileName = sanitizeFileName(resource.fileName || (resource.type === "audio" ? `${resource.fileKey}.ogg` : resource.fileKey));
      const filePath = join(targetDir, `${Date.now()}-${randomUUID()}-${fileName}`);
      await writeFile(filePath, buffer);
      totalBytes += buffer.length;
      attachmentNote += `\n[${resource.type === "audio" ? "语音" : resource.type === "video" ? "视频" : "附件"}] ${fileName} 已保存到: ${filePath}`;
      if (resource.type === "audio" && transcribe) {
        try {
          const words = await transcribe(buffer, fileName);
          if (words) attachmentNote += `\n[语音转写] ${words}`;
        } catch (error) {
          logger.warn(`[LarkTransport] 语音转写失败 ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      logger.warn(`[LarkTransport] 下载附件失败 ${resource.fileKey}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return attachmentNote;
}

/** 过滤消息中的 @ 机器人标记（normalize 已按占位符替换，这里对残留标记兜底清洗）。 */
export function stripBotMentions(text: string, botOpenId: string | undefined): string {
  if (!botOpenId) return text.trim();
  return text
    .replace(new RegExp(`<at\\s+user_id="${botOpenId}"[^>]*>.*?</at>`, "gi"), "")
    .replace(new RegExp(`@${botOpenId}\\s*`, "gi"), "")
    .trim();
}

/** 飞书根消息独立成话题；回复使用 threadId，不猜测群内“待定根”。 */
export function buildConversationId(chatId: string, chatMode: "p2p" | "group" | "topic", threadId: string | undefined, messageId: string): string {
  return chatMode === "topic" ? `topic:${chatId}:${threadId ?? messageId}` : `${chatMode}-${chatId}`;
}
