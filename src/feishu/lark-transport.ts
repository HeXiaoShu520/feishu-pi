import { EventDispatcher, normalize, normalizeCardAction, WSClient, type Client } from "@larksuiteoapi/node-sdk";
import type { FeishuInboundMessage, FeishuTransport } from "./types.ts";
import { LarkCli } from "./lark-cli.ts";
import { TopicRootStore } from "./topic-root-store.ts";
import { LarkImageProcessor } from "./image-processor.ts";
import { formatLogText } from "./log-utils.ts";
import { logger } from "../utils/logger.ts";
import { attachmentsDir, sanitizeFileName } from "../utils/session-paths.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  /** 图片缓存目录（可选） */
  imageCacheDir?: string;
  /** 会话数据根目录（可选，提供后支持 file/audio/video 附件下载，存放在 {根目录}/{会话}/files/） */
  sessionDataDir?: string;
  /** 管理员 Open ID（可选） */
  adminOpenId?: string;
  /** 话题根持久化文件路径（话题群会话收敛用） */
  topicRootsFile?: string;
  /**
   * 管理员用户 token 提供器（来自 /login，FEISHU_ADMIN 的 user_access_token）。
   * 提供后启用用户资料的"管理员身份查询"通道：补群成员英文名/部门，并兜底查应用可用范围外的用户。
   */
  adminTokenProvider?: () => Promise<string | undefined>;
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
  private approvalHandler?: (params: { value: Record<string, unknown>; action: { messageId: string; chatId: string; operatorOpenId: string } }) => Promise<void>;
  private askHandler?: (params: { value: Record<string, unknown>; action: { messageId: string; chatId: string; operatorOpenId: string } }) => Promise<void>;
  private connecting?: Promise<void>;
  /** 会话模式缓存（p2p/group/topic），话题群与普通群的会话隔离策略不同 */
  private readonly chatModeCache = new Map<string, "p2p" | "group" | "topic">();
  /** 话题根持久化（chatId -> 待定话题根 messageId） */
  private readonly topicRoots?: TopicRootStore;
  /** 会话数据根目录（附件下载到 {根目录}/{会话}/files/） */
  private readonly sessionDataDir?: string;
  /** 图片缓存目录（供附件下载参考） */
  private readonly imageCacheDir?: string;

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
    this.imageCacheDir = config.imageCacheDir;
    if (config.topicRootsFile) {
      this.topicRoots = new TopicRootStore(config.topicRootsFile);
    }
    this.larkCli = new LarkCli(config.client, config.appId, config.userProfileDir, {
      adminTokenProvider: config.adminTokenProvider,
    });
    this.imageProcessor = new LarkImageProcessor(config.client, {
      cacheDir: config.imageCacheDir,
    });
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
          await this.dispatchMessage(message as unknown as { messageId: string; chatId: string; threadId?: string; senderId: string; content: string; resources?: Array<{ type: string; fileKey: string; fileName?: string }> });
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
      this.connecting = undefined;
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
  }): Promise<void> {
    if (this.botOpenId && message.senderId === this.botOpenId) return;
    const chatId = message.chatId;
    try {
      // 会话模式先行：决定用户资料的查询通道（私聊 contact API / 群聊群成员名单）与 conversationId 归属
      const chatMode = await this.getChatModeCached(chatId);
      const profile = await this.larkCli.getUserProfile(message.senderId, chatId);
      const displayName = profile.name || profile.en_name || message.senderId;

      // 构造 conversationId：
      // - 话题群：同一话题内所有用户共享一个会话；首条消息没有 threadId，
      //   用该消息的 messageId 作为话题键并持久化——后续消息的 threadId 恰好就是这条根消息的 ID，
      //   收敛到同一会话；若根未确立前用户追加消息，从持久化中取回话题根，避免裂成新会话
      // - 其他会话（私聊/普通群）：按用户隔离
      const threadId = message.threadId;
      let conversationId: string;
      if (chatMode === "topic") {
        let rootId = threadId;
        if (rootId) {
          await this.topicRoots?.clear(chatId); // threadId 出现，话题根已确立
        } else {
          const pending = await this.topicRoots?.get(chatId);
          rootId = pending ?? message.messageId;
          if (!pending) await this.topicRoots?.set(chatId, rootId); // 首条消息：登记自己为话题根
        }
        conversationId = `topic:${chatId}:${rootId}`;
      } else {
        conversationId = `${message.senderId}-${threadId ? `${chatId}:thread:${threadId}` : `chat:${chatId}`}`;
      }

      // 处理图片附件（含 post 富文本里的图片：SDK 会把它们放进 resources）
      let images;
      let imageCount = 0;
      const resources = (message as unknown as { resources?: Array<{ type: string; fileKey: string; fileName?: string }> }).resources ?? [];
      if (resources.length > 0) {
        const imageKeys = resources.filter((r) => r.type === "image").map((r) => r.fileKey);
        if (imageKeys.length > 0) {
          imageCount = imageKeys.length;
          images = await this.imageProcessor?.processImages(imageKeys);
        }
      }

      // 过滤消息中的 @ 机器人标记（normalize 已按占位符替换，这里兜底清洗）
      let cleanedText = message.content;
      if (this.botOpenId) {
        cleanedText = cleanedText
          .replace(new RegExp(`<at\\s+user_id="${this.botOpenId}"[^>]*>.*?</at>`, "gi"), "")
          .replace(new RegExp(`@${this.botOpenId}\\s*`, "gi"), "")
          .trim();
      }

      // 下载文件类附件（file/audio/video/media），保存到会话文件夹并把路径写进消息文本，
      // Agent 可用 read/bash 直接访问
      if (this.sessionDataDir) {
        const attachmentNote = await downloadFileAttachments(
          this.sessionDataDir,
          conversationId,
          resources,
          (fileKey, type) => this.downloadResource(fileKey, type),
        );
        if (attachmentNote) cleanedText += attachmentNote;
      }

      // 记录收到的消息
      const imageInfo = imageCount > 0 ? `（含 ${imageCount} 张图片）` : "";
      logger.userInput(displayName, `: ${imageInfo}${formatLogText(cleanedText)}`);

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

  /** 查询会话模式并缓存（话题群与普通群的会话隔离策略不同，模式极少变化）。 */
  private async getChatModeCached(chatId: string): Promise<"p2p" | "group" | "topic"> {
    const cached = this.chatModeCache.get(chatId);
    if (cached) return cached;
    try {
      const res = await this.client.im.v1.chat.get({ path: { chat_id: chatId } });
      const mode = (res.data as { chat_mode?: string } | undefined)?.chat_mode;
      const result: "p2p" | "group" | "topic" = mode === "p2p" ? "p2p" : mode === "topic" ? "topic" : "group";
      this.chatModeCache.set(chatId, result);
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
    const content = readFileSync(envFile, "utf-8");
    const line = `FEISHU_PI_MODEL_NAME=${modelName}`;
    const pattern = /^FEISHU_PI_MODEL_NAME=.*$/m;
    writeFileSync(envFile, pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}\n${line}\n`, "utf-8");
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

  /** 下载消息资源（image/file）为 Buffer。 */
  private async downloadResource(fileKey: string, type: string): Promise<Buffer> {
    const res =
      type === "image"
        ? await this.client.im.v1.image.get({ path: { image_key: fileKey } })
        : await this.client.im.v1.file.get({ path: { file_key: fileKey } });
    return bufferFromResponse(res as unknown);
  }

  /** 关闭飞书长连接。 */
  async disconnect(): Promise<void> {
    this.wsClient?.close();
  }

  onMessage(handler: (message: FeishuInboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  /** 注册授权卡片回调处理器（PermissionBroker 在服务端校验管理员身份）。 */
  onApproval(handler: (params: { value: Record<string, unknown>; action: { messageId: string; chatId: string; operatorOpenId: string } }) => Promise<void>): void {
    this.approvalHandler = handler;
  }

  /** 注册选项卡回调处理器（AskBroker 校验存在性/一次性 token/仅本人）。 */
  onAskUser(handler: (params: { value: Record<string, unknown>; action: { messageId: string; chatId: string; operatorOpenId: string } }) => Promise<void>): void {
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
 * 历史记录与附件同住一个会话文件夹，磁盘布局与会话隔离模型一一对应。
 * 文件名带时间戳前缀，同一会话先后传同名文件不互相覆盖；单个下载失败只记 warn，不影响其余附件。
 */
export async function downloadFileAttachments(
  sessionDataDir: string,
  conversationId: string,
  resources: ReadonlyArray<{ type: string; fileKey: string; fileName?: string }>,
  download: (fileKey: string, type: string) => Promise<Buffer>,
): Promise<string> {
  const fileResources = resources.filter((r) => ["file", "audio", "video", "media"].includes(r.type) && r.fileKey);
  if (fileResources.length === 0) return "";

  const { writeFile, mkdir } = await import("node:fs/promises");
  const targetDir = attachmentsDir(sessionDataDir, conversationId);
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

/** 把资源下载接口的返回（wrapper/流/Buffer）收敛为 Buffer。 */
function bufferFromResponse(res: unknown): Promise<Buffer> {
  const collect = (stream: NodeJS.ReadableStream) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });

  const anyRes = res as { data?: unknown; getReadableStream?: () => NodeJS.ReadableStream } | Buffer | undefined;
  if (Buffer.isBuffer(anyRes)) return Promise.resolve(anyRes);
  if (anyRes && typeof anyRes === "object") {
    if (typeof anyRes.getReadableStream === "function") return collect(anyRes.getReadableStream());
    if (Buffer.isBuffer(anyRes.data)) return Promise.resolve(anyRes.data);
    if (anyRes.data && typeof (anyRes.data as NodeJS.ReadableStream).on === "function") return collect(anyRes.data as NodeJS.ReadableStream);
  }
  return Promise.reject(new Error("无法识别的资源下载响应结构"));
}
