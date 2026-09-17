import { EventDispatcher, normalize, normalizeCardAction, WSClient, type Client } from "@larksuiteoapi/node-sdk";
import type { FeishuInboundMessage, FeishuTransport } from "./types.ts";
import { LarkCli } from "./lark-cli.ts";
import { TopicRootStore } from "./topic-root-store.ts";
import { LarkImageProcessor } from "./image-processor.ts";
import { formatLogText } from "./log-utils.ts";
import { logger } from "../utils/logger.ts";
import { attachmentsDir, sanitizeFileName } from "../utils/session-paths.ts";
import { upsertEnvLine } from "../utils/env-file.ts";
import { toBuffer } from "./resource-buffer.ts";
import { extractCredentialFields } from "./credential-card.ts";
import { mentionedUserIds } from "./people-roster.ts";
import { WorkspaceManager } from "./workspace.ts";
import { redactSecrets } from "../utils/redact.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 卡片回调的统一参数：按钮 value 载荷 + 回调来源（卡片消息与点击者） */
export interface CardCallbackParams {
  /** 按钮 behaviors.value 载荷（action/qid/token/decision 等，结构随卡片而定） */
  value: Record<string, unknown>;
  /** 回调来源：被点击的卡片消息 ID、所在会话与点击者 */
  action: { messageId: string; chatId: string; operatorOpenId: string };
}

/** 会话模式缓存条目上限（超出驱逐最久未用） */
const CHAT_MODE_CACHE_MAX = 500;

/** 凭证表单卡回调参数：字段值已从 form_value/input_value 提取（不得写日志） */
export interface CredentialSubmitParams {
  /** 按钮回传参数（含 provider） */
  value: Record<string, unknown>;
  /** 回调来源：卡片消息 ID（用于原地更新结果卡）、会话与提交者 */
  action: { messageId: string; chatId: string; operatorOpenId: string };
  /** 提交的表单字段（已 trim；空值剔除） */
  fields: Record<string, string>;
}

export interface LarkTransportConfig {
  appId: string;
  appSecret: string;
  botOpenId?: string;
  source?: string;
  userProfileDir?: string;
  handshakeTimeoutMs?: number;
  pingTimeout?: number;
  /** 飞书 Client 实例（消息发送、卡片更新、资源下载等 API 调用） */
  client: Client;
  /** 会话数据根目录（可选，提供后支持 file/audio/video 附件下载，存放在 {根目录}/{会话}/files/） */
  sessionDataDir?: string;
  /** 管理员 Open ID（可选） */
  adminOpenId?: string;
  /** 话题根持久化文件路径（话题群会话收敛用） */
  topicRootsFile?: string;
  /** 会话工作区根目录（可选，默认 work_space/）：每个会话一个文件夹收纳其文件 */
  workspaceRoot?: string;
  /** lark-cli 用户态搜索通道（contact +search-user，见 lark-cli-search.ts）：部门信息的来源 */
  searchUserProfile?: (openId: string) => Promise<{ name?: string; en_name?: string; department_name?: string[] } | undefined>;
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
 * 消息去重由 MessageStore.claim 保证，会话内顺序由 ConversationManager 保证。
 */
export class LarkTransport implements FeishuTransport {
  private wsClient?: WSClient;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly botOpenId?: string;
  private readonly source: string;
  private readonly handshakeTimeoutMs: number;
  private readonly pingTimeout: number;
  private readonly larkCli: LarkCli;
  private readonly imageProcessor?: LarkImageProcessor;
  private readonly adminOpenId?: string;
  private readonly onModelSwitch?: (modelName: string) => void;
  private readonly client: Client;
  private handler?: (message: FeishuInboundMessage) => Promise<void>;
  private approvalHandler?: (params: CardCallbackParams) => Promise<void>;
  private askHandler?: (params: CardCallbackParams) => Promise<void>;
  private connecting?: Promise<void>;
  /** 会话模式缓存（p2p/group/topic），话题群与普通群的会话隔离策略不同 */
  private readonly chatModeCache = new Map<string, "p2p" | "group" | "topic">();  /** 话题根持久化（chatId -> 待定话题根 messageId） */
  private readonly topicRoots?: TopicRootStore;
  private readonly workspace?: WorkspaceManager;
  /** 会话数据根目录（附件下载到 {根目录}/{会话}/files/） */
  private readonly sessionDataDir?: string;
  /** 图片缓存目录（供附件下载参考） */

  constructor(config: LarkTransportConfig) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.botOpenId = config.botOpenId;
    this.source = config.source ?? "feishu-pi";
    this.handshakeTimeoutMs = config.handshakeTimeoutMs ?? 15_000;
    this.pingTimeout = config.pingTimeout ?? 30;
    this.adminOpenId = config.adminOpenId;
    this.onModelSwitch = config.onModelSwitch;
    this.client = config.client;
    this.sessionDataDir = config.sessionDataDir;
    if (config.topicRootsFile) {
      this.topicRoots = new TopicRootStore(config.topicRootsFile);
    }
    if (config.workspaceRoot) {
      this.workspace = new WorkspaceManager(config.workspaceRoot);
    }
    this.larkCli = new LarkCli(config.appId, config.userProfileDir, {
      searchUser: config.searchUserProfile,
    });
    this.imageProcessor = new LarkImageProcessor(config.client);
  }

  /** 建立飞书长连接并开始接收事件。 */
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.wsClient) return; // 已连接（WSClient 自带重连，无需重复 start）

    const dispatcher = new EventDispatcher({});
    dispatcher.register({
      // 未使用的事件注册空处理器：避免 SDK 对每个未订阅事件打 "no xxx handle" 无上下文警告
      "im.chat.member.bot.added_v1": async () => {},
      "im.message.reaction.created_v1": async () => {},
      "im.message.reaction.deleted_v1": async () => {},
      "im.message.message_read_v1": async () => {},
      // 普通消息：normalize 归一化（content/resources/mentions），交给 handler 后台处理
      "im.message.receive_v1": async (raw: Record<string, unknown>) => {
        try {
          const message = await normalize(raw as never, {
            botIdentity: this.botOpenId ? { openId: this.botOpenId } : undefined,
            stripBotMentions: true,
            includeRaw: true,
          } as never);
          if (!message) return;
          await this.dispatchMessage(message as unknown as { messageId: string; chatId: string; threadId?: string; senderId: string; content: string; resources?: Array<{ type: string; fileKey: string; fileName?: string }>; mentions?: Array<{ openId?: string; name?: string; isBot?: boolean }>; mentionedBot?: boolean });
        } catch (error) {
          logger.error("[LarkTransport] 消息归一化/分发失败:", error);
        }
      },
      // 卡片回调：handler 返回值（toast）会进 ACK 帧，反馈点击行为——不再弹「超时未响应」
      "card.action.trigger": async (raw: Record<string, unknown>) => {
        const evt = normalizeCardAction(raw as object, { includeRaw: true });
        if (evt) {
          logger.info(`[CardAction] 收到卡片回调: ${evt.operator.openId}`);
          void this.handleCardAction(evt).catch((error) => logger.error("[CardAction] 处理卡片回调失败:", error));
        }
        return { toast: { type: "info", content: "✅ 已收到，处理中…" } };
      },
    });

    this.wsClient = new WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      source: this.source,
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
   * 会话内的顺序由 ConversationManager 保证，消息去重由 MessageStore.claim 保证。
   */
  private async dispatchMessage(message: {
    messageId: string;
    chatId: string;
    threadId?: string;
    senderId: string;
    content: string;
    resources?: Array<{ type: string; fileKey: string; fileName?: string }>;
    mentions?: Array<{ openId?: string; name?: string; isBot?: boolean }>;
    mentionedBot?: boolean;
  }): Promise<void> {
    if (this.botOpenId && message.senderId === this.botOpenId) return;
    const chatId = message.chatId;
    try {
      // 会话模式先行：决定响应资格（群聊需 @）与 conversationId 归属
      const chatMode = await this.getChatModeCached(chatId);

      // 群聊/话题群只响应 @机器人 的消息；私聊全响应。
      // 未 @ 的消息静默忽略（不查资料、不入会话，避免群聊刷屏误触发）。
      if (chatMode !== "p2p" && !message.mentionedBot) return;

      // 会话 ID + 工作区文件夹最先就位：消息一旦开始处理，
      // 归属与落盘位置即已确定（先于资料查询与模型思考）
      const threadId = message.threadId;
      const conversationId = await this.buildConversationId(chatId, chatMode, threadId, message.messageId);
      const workspaceDir = this.workspace ? await this.workspace.dirFor(conversationId) : undefined;

      const profile = await this.larkCli.getUserProfile(message.senderId);
      const displayName = profile.name || profile.en_name || message.senderId;

      // @ 提及入库（后台，不阻塞消息处理）：被 @ 的人也走资料查询链路写入用户名单
      // （data/users/{appId}_users.json，人员提示/权限分组/管理员识别共用）。
      // 查询链路自带 3 天缓存与并发合并：已入库的人零 API 开销。
      for (const mentioned of mentionedUserIds(message.mentions ?? [], message.senderId)) {
        void this.larkCli.getUserProfile(mentioned).catch(() => undefined);
      }

      // 处理图片附件（含 post 富文本里的图片：SDK 会把它们放进 resources）
      let images;
      let imageCount = 0;
      const resources = (message as unknown as { resources?: Array<{ type: string; fileKey: string; fileName?: string }> }).resources ?? [];
      if (resources.length > 0) {
        const imageKeys = resources.filter((r) => r.type === "image").map((r) => r.fileKey);
        if (imageKeys.length > 0) {
          imageCount = imageKeys.length;
          images = await this.imageProcessor?.processImages(imageKeys, workspaceDir ? join(workspaceDir, "images") : undefined);
        }
      }

      // 过滤消息中的 @ 机器人标记（normalize 已按占位符替换，这里兜底清洗）
      let cleanedText = stripBotMentions(message.content, this.botOpenId);

      // 下载文件类附件（file/audio/video/media），保存到会话文件夹并把路径写进消息文本，
      // Agent 可用 read/bash 直接访问
      if (this.sessionDataDir) {
        const attachmentNote = await downloadFileAttachments(
          workspaceDir ?? join(this.sessionDataDir, conversationId),
          resources,
          (fileKey, type) => this.downloadResource(fileKey, type),
        );
        if (attachmentNote) cleanedText += attachmentNote;
      }

      // 记录收到的消息
      const imageInfo = imageCount > 0 ? `（含 ${imageCount} 张图片）` : "";
      logger.userInput(displayName, `: ${imageInfo}${formatLogText(redactSecrets(cleanedText))}`);

      // 判断是否为管理员
      const isAdmin = this.adminOpenId ? message.senderId === this.adminOpenId : false;

      // fire-and-forget：后台处理，失败仅记日志
      void this.handler?.({
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
      }).catch((error) => {
        logger.error(`[LarkTransport] 消息处理失败: ${error instanceof Error ? error.message : error}`);
      });
    } catch (error) {
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
          action: { messageId: action.messageId, chatId: action.chatId, operatorOpenId: action.operator.openId },
        });
        return;
      }

      // 选项卡回调（ask_user）：交给 AskBroker 校验（存在性/一次性 token/仅本人）
      if (typeof value === "object" && value?.action === "ask_user") {
        await this.askHandler?.({
          value,
          action: { messageId: action.messageId, chatId: action.chatId, operatorOpenId: action.operator.openId },
        });
        return;
      }

      // 凭证表单卡回调（form_submit）：输入内容经回调直达服务端，不落聊天记录；
      // 字段值不写日志，handler 自行加密入库
      if (typeof value === "object" && value?.action === "credential_submit") {
        const rawAction = (action.raw as { action?: unknown } | undefined)?.action;
        await this.credentialSubmitHandler?.({
          value,
          action: { messageId: action.messageId, chatId: action.chatId, operatorOpenId: action.operator.openId },
          fields: extractCredentialFields(rawAction),
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
          if (!modelName) throw new Error("模型 ID 不能为空");
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

  /**
   * 构造会话 ID（会话隔离的核心规则）：
   * - 话题群：同一话题内所有用户共享一个会话；首条消息没有 threadId，
   *   用该消息的 messageId 作为话题键并持久化——后续消息的 threadId 恰好就是这条根消息的 ID，
   *   收敛到同一会话；若根未确立前用户追加消息，从持久化中取回话题根，避免裂成新会话。
   * - 私聊：会话即本人历史；普通群：全群共享一个会话——两者都以 chatId 命名（会话 ID，
   *   不带用户 ID），/new 清除后从头开始。
   */
  private async buildConversationId(chatId: string, chatMode: "p2p" | "group" | "topic", threadId: string | undefined, messageId: string): Promise<string> {
    if (chatMode !== "topic") {
      // 私聊 = 本人历史；普通群 = 全群共享：都以会话（chat）命名，不按用户隔离
      return `${chatMode}-${chatId}`;
    }
    // 话题根的"读-判-写"必须按 chatId 串行：并发首消息各自登记自己为根会把同一话题裂成两个会话
    return this.withTopicRootLock(chatId, async () => {
      let rootId = threadId;
      if (rootId) {
        await this.topicRoots?.clear(chatId); // threadId 出现，话题根已确立
      } else {
        const pending = await this.topicRoots?.get(chatId);
        rootId = pending ?? messageId;
        if (!pending) await this.topicRoots?.set(chatId, rootId); // 首条消息：登记自己为话题根
      }
      return `topic:${chatId}:${rootId}`;
    });
  }

  /** 话题根登记锁：同一 chatId 的根判定串行化；前序失败不阻塞后续。 */
  private readonly topicRootLocks = new Map<string, Promise<void>>();
  private async withTopicRootLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.topicRootLocks.get(chatId) ?? Promise.resolve();
    const task = previous.then(fn, fn);
    this.topicRootLocks.set(chatId, task.then(() => undefined, () => undefined));
    return task;
  }

  /** 查询会话模式并缓存（话题群与普通群的会话隔离策略不同，模式极少变化）。
   *  缓存有上限（近似 LRU：超限驱逐最早条目），长驻进程不无限增长。 */
  private async getChatModeCached(chatId: string): Promise<"p2p" | "group" | "topic"> {
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
      logger.warn(`[LarkTransport] 获取会话模式失败，按普通会话处理: ${error instanceof Error ? error.message : error}`);
      return "group";
    }
  }

  /** 持久化模型配置并通知运行时热切换（供服务重启与当前进程同时生效）。 */
  private persistModelName(modelName: string): void {
    this.onModelSwitch?.(modelName);
    const envFile = join(process.cwd(), ".env");
    const updated = upsertEnvLine(readFileSync(envFile, "utf-8"), "FEISHU_PI_MODEL_NAME", modelName);
    writeFileSync(envFile, updated, "utf-8");
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

  /** 下载消息资源（image/file）为 Buffer（响应形态差异由 resource-buffer 收敛）。 */
  private async downloadResource(fileKey: string, type: string): Promise<Buffer> {
    const res =
      type === "image"
        ? await this.client.im.v1.image.get({ path: { image_key: fileKey } })
        : await this.client.im.v1.file.get({ path: { file_key: fileKey } });
    return toBuffer(res);
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

  private credentialSubmitHandler?: (params: CredentialSubmitParams) => Promise<void>;

  /** 注册凭证表单卡回调（form_submit → credential_submit）：字段值不得写入日志。 */
  onCredentialSubmit(handler: (params: CredentialSubmitParams) => Promise<void>): void {
    this.credentialSubmitHandler = handler;
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

  /**
   * 启动第 3 步：收集机器人所在会话（群聊 + 私聊）的成员 openId + 姓名，
   * 以姓名写入用户名单（不查部门——部门在该成员实际互动时经 search-user 补全）。
   * 上限 50 会话 / 500 人，返回入库人数。
   */
  async ingestTeamOpenIds(opts: { botOpenId?: string; maxChats?: number; maxMembers?: number } = {}): Promise<number> {
    const maxChats = opts.maxChats ?? 50;
    const maxMembers = opts.maxMembers ?? 500;
    const entries = new Map<string, string>();
    let chatCount = 0;
    let pageToken: string | undefined;
    const collectChat = async (chatId: string): Promise<void> => {
      chatCount += 1;
      let memberToken: string | undefined;
      do {
        const res = await this.client.im.chatMembers.get({
          path: { chat_id: chatId },
          params: { member_id_type: "open_id", page_size: 100, page_token: memberToken },
        });
        for (const member of ((res.data?.items ?? []) as Array<{ member_id?: string; name?: string }>)) {
          const id = member.member_id;
          if (!id || id === opts.botOpenId || entries.has(id) || entries.size >= maxMembers) continue;
          entries.set(id, member.name ?? "");
        }
        memberToken = (res.data as { page_token?: string } | undefined)?.page_token;
      } while (memberToken && entries.size < maxMembers);
    };
    try {
      do {
        const res = await this.client.im.v1.chat.list({ params: { page_size: 100, page_token: pageToken } });
        for (const chat of ((res.data?.items ?? []) as Array<{ chat_id?: string }>)) {
          if (chat.chat_id && chatCount < maxChats && entries.size < maxMembers) await collectChat(chat.chat_id);
        }
        pageToken = (res.data as { page_token?: string } | undefined)?.page_token;
      } while (pageToken && chatCount < maxChats && entries.size < maxMembers);
    } catch (error) {
      logger.warn(`[Roster] 团队成员收集中断（已完成部分保留）: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.larkCli.upsertRosterNames([...entries].map(([openId, name]) => ({ openId, name })));
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
}

/**
 * 下载文件类附件（file/audio/video/media）到会话文件夹的 files/ 子目录
 * （`{sessionDataDir}/{会话目录}/files/`），返回要追加到消息文本的附件说明（无附件时为空串）。
 *
 * 附件落盘到指定的目标目录（会话工作区/files）。
 * 文件名带时间戳前缀，同一会话先后传同名文件不互相覆盖；单个下载失败只记 warn，不影响其余附件。
 */
export async function downloadFileAttachments(
  targetDir: string,
  resources: ReadonlyArray<{ type: string; fileKey: string; fileName?: string }>,
  download: (fileKey: string, type: string) => Promise<Buffer>,
): Promise<string> {
  const fileResources = resources.filter((r) => ["file", "audio", "video", "media"].includes(r.type) && r.fileKey);
  if (fileResources.length === 0) return "";

  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(targetDir, { recursive: true });

  let attachmentNote = "";
  for (const resource of fileResources.slice(0, 5)) {
    try {
      const buffer = await download(resource.fileKey, resource.type);
      const fileName = sanitizeFileName(resource.fileName || resource.fileKey);
      const filePath = join(targetDir, `${Date.now()}-${fileName}`);
      await writeFile(filePath, buffer);
      attachmentNote += `\n[附件] ${fileName} 已保存到: ${filePath}`;
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
