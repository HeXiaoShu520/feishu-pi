import { createLarkChannel, type LarkChannel } from "@larksuiteoapi/node-sdk";
import type { FeishuInboundMessage, FeishuReply, FeishuTransport } from "./types.ts";
import { LarkCli } from "./lark-cli.ts";
import { TopicRootStore } from "./topic-root-store.ts";
import { LarkImageProcessor } from "./image-processor.ts";
import { formatLogText } from "./log-utils.ts";
import type { Client } from "@larksuiteoapi/node-sdk";
import { logger } from "../utils/logger.ts";
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
  /** 飞书 Client 实例（用于图片下载） */
  client?: Client;
  /** 图片缓存目录（可选） */
  imageCacheDir?: string;
  /** 管理员 Open ID（可选） */
  adminOpenId?: string;
  /** 话题根持久化文件路径（话题群会话收敛用） */
  topicRootsFile?: string;
}

/** 基于飞书官方高层 Channel 的最小消息传输实现。 */
export class LarkTransport implements FeishuTransport {
  private readonly channel: LarkChannel;
  private readonly botOpenId?: string;
  private readonly larkCli: LarkCli;
  private readonly imageProcessor?: LarkImageProcessor;
  private readonly adminOpenId?: string;
  private readonly client?: Client;
  private handler?: (message: FeishuInboundMessage) => Promise<void>;
  private approvalHandler?: (params: { value: Record<string, unknown>; action: { messageId: string; chatId: string; operatorOpenId: string } }) => Promise<void>;
  private messageHandlerRegistered = false;
  private connecting?: Promise<void>;
  /** 会话模式缓存（p2p/group/topic），话题群与普通群的会话隔离策略不同 */
  private readonly chatModeCache = new Map<string, "p2p" | "group" | "topic">();
  /** 话题根持久化（chatId -> 待定话题根 messageId） */
  private readonly topicRoots?: TopicRootStore;

  constructor(config: LarkTransportConfig) {
    this.botOpenId = config.botOpenId;
    this.adminOpenId = config.adminOpenId;
    this.client = config.client;
    if (config.topicRootsFile) {
      this.topicRoots = new TopicRootStore(config.topicRootsFile);
    }
    this.larkCli = new LarkCli(config.client!, config.appId, config.userProfileDir);
    if (config.client) {
      this.imageProcessor = new LarkImageProcessor(config.client, {
        cacheDir: config.imageCacheDir,
      });
    }
    this.channel = createLarkChannel({
      appId: config.appId,
      appSecret: config.appSecret,
      transport: "websocket",
      source: config.source ?? "feishu-pi",
      handshakeTimeoutMs: config.handshakeTimeoutMs ?? 15_000,
      wsConfig: { pingTimeout: config.pingTimeout ?? 30 },
      safety: { dedup: { maxEntries: 10_000, ttl: 10 * 60 * 1000 } },
      includeRawEvent: true,
    });
    this.channel.on("reconnecting", () => logger.warn("[LarkTransport] 飞书 WebSocket 正在重连"));
    this.channel.on("reconnected", () => logger.info("[LarkTransport] 飞书 WebSocket 已恢复"));
    this.channel.on("error", (error) => logger.error("[LarkTransport] 飞书 WebSocket 错误", error));
  }

  /** 建立飞书长连接并开始接收消息。 */
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (!this.messageHandlerRegistered) {
      this.messageHandlerRegistered = true;

      // 监听普通消息
      this.channel.on("message", async (message) => {
        if (this.botOpenId && message.senderId === this.botOpenId) return;
        const chatId = message.chatId;
        const threadId = message.threadId;
        try {
          const profile = await this.larkCli.getUserProfile(message.senderId, chatId);
          const displayName = profile.name || profile.englishName || profile.openId;

          // 构造 conversationId：
          // - 话题群：同一话题内所有用户共享一个会话；首条消息没有 threadId，
          //   用该消息的 messageId 作为话题键并持久化——后续消息的 threadId 恰好就是这条根消息的 ID，
          //   收敛到同一会话；若根未确立前用户追加消息，从持久化中取回话题根，避免被打断后裂成新会话
          // - 其他会话（私聊/普通群）：按用户隔离
          const chatMode = await this.getChatModeCached(chatId);
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
            conversationId = `${profile.openId}-${threadId ? `${chatId}:thread:${threadId}` : `chat:${chatId}`}`;
          }

          // 处理图片附件
          let images;
          let imageCount = 0;
          if (this.imageProcessor && message.resources && message.resources.length > 0) {
            const imageKeys = message.resources
              .filter((r) => r.type === "image")
              .map((r) => r.fileKey);

            if (imageKeys.length > 0) {
              imageCount = imageKeys.length;
              images = await this.imageProcessor.processImages(imageKeys);
            }
          }

          // 记录收到的消息
          const msgPreview = formatLogText(message.content);
          const imageInfo = imageCount > 0 ? `（含 ${imageCount} 张图片）` : "";
          logger.userInput(displayName, `收到消息${imageInfo}: ${msgPreview}`);

          // 过滤消息中的 @ 机器人标记
          let cleanedText = message.content;
          if (this.botOpenId) {
            // 匹配 @bot_xxx 或 <at user_id="bot_xxx"></at> 等格式
            cleanedText = cleanedText
              .replace(new RegExp(`<at\\s+user_id="${this.botOpenId}"[^>]*>.*?</at>`, "gi"), "")
              .replace(new RegExp(`@${this.botOpenId}\\s*`, "gi"), "")
              .trim();
          }

          // 判断是否为管理员
          const isAdmin = this.adminOpenId ? profile.openId === this.adminOpenId : false;

          await this.handler?.({
            messageId: message.messageId,
            chatId,
            context: {
              userOpenId: profile.openId,
              userName: displayName,
              departmentNames: profile.departmentNames,
              chatId,
              threadId,
              conversationId,
              isAdmin,
            },
            text: cleanedText,
            images,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          logger.error(`[${message.senderId}] ${detail}`);
          await this.channel.send(`无法读取用户资料：${detail}`, { text: `无法读取用户资料：${detail}` }, { replyTo: message.messageId, replyInThread: true });
        }
      });

      // 监听卡片回调事件
      this.channel.on("cardAction", async (action) => {
        try {
          logger.info(`[CardAction] 收到卡片回调: ${action.operator.openId}`);

          // 解析回调数据（value 可能是对象或 JSON 字符串）
          let value: Record<string, unknown> | string = action.action.value as any;
          if (typeof value === "string") {
            try {
              value = JSON.parse(value);
            } catch {
              logger.warn(`[CardAction] value 不是有效的 JSON: ${value}`);
            }
          }

          // 授权卡回调（授权/拒绝/申请转发）：交给 PermissionBroker 在服务端校验（含管理员身份），不走通用管理员拦截
          if (typeof value === "object" && (value?.action === "tool_approval" || value?.action === "forward_approval")) {
            await this.approvalHandler?.({
              value,
              action: { messageId: action.messageId, chatId: action.chatId, operatorOpenId: action.operator.openId },
            });
            return;
          }

          // 判断是否为管理员
          const operatorOpenId = action.operator.openId;
          const isAdmin = this.adminOpenId ? operatorOpenId === this.adminOpenId : false;

          if (!isAdmin) {
            logger.warn(`[CardAction] 非管理员点击卡片: ${operatorOpenId}`);
            // 更新卡片显示权限错误
            await this.updateCard(action, {
              schema: "2.0",
              header: {
                title: {
                  tag: "plain_text",
                  content: "模型切换",
                },
              },
              body: {
                elements: [
                  {
                    tag: "markdown",
                    content: "❌ 仅管理员可执行此操作",
                  },
                ],
              },
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
                header: {
                  title: {
                    tag: "plain_text",
                    content: "模型切换结果",
                  },
                },
                config: {
                  update_multi: true,
                },
                body: {
                  elements: [
                    {
                      tag: "markdown",
                      content: `✅ 已切换到模型：${value.model_id}\n\n当前卡片已更新。`,
                    },
                  ],
                },
              });
              logger.info(`[CardAction] 卡片更新成功`);
            } catch (err) {
              logger.error(`[CardAction] 更新卡片失败:`, err);
            }
          }
        } catch (error) {
          logger.error("[CardAction] 处理卡片回调失败:", error);
        }
      });
    }
    this.connecting = this.channel.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  /** 查询会话模式并缓存（话题群与普通群的会话隔离策略不同，模式极少变化）。 */
  private async getChatModeCached(chatId: string): Promise<"p2p" | "group" | "topic"> {
    const cached = this.chatModeCache.get(chatId);
    if (cached) return cached;
    try {
      const mode = await this.channel.getChatMode(chatId);
      this.chatModeCache.set(chatId, mode);
      return mode;
    } catch (error) {
      logger.warn(`[LarkTransport] 获取会话模式失败，按普通会话处理: ${error instanceof Error ? error.message : error}`);
      return "group";
    }
  }

  /** 持久化模型配置，供服务重启后使用。 */
  private persistModelName(modelName: string): void {
    const envFile = join(process.cwd(), ".env");
    const content = readFileSync(envFile, "utf-8");
    const line = `FEISHU_PI_MODEL_NAME=${modelName}`;
    const pattern = /^FEISHU_PI_MODEL_NAME=.*$/m;
    writeFileSync(envFile, pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}\n${line}\n`, "utf-8");
  }

  /**
   * 更新卡片。优先按 messageId 持久更新（实体变更，重新拉取不回退）；
   * 失败时回退到卡片回调 token 的临时更新（仅本次点击视图可见，客户端重新拉取会还原）。
   */
  private async updateCard(action: { messageId: string; raw?: unknown }, card: object): Promise<void> {
    try {
      await this.channel.updateCard(action.messageId, card);
      return;
    } catch (error) {
      logger.warn(`[LarkTransport] 按 messageId 更新卡片失败，回退 token 更新: ${error instanceof Error ? error.message : error}`);
    }

    const raw = action.raw as { token?: string } | undefined;
    if (raw?.token && this.client) {
      await this.client.request({
        method: "POST",
        url: "/open-apis/interactive/v1/card/update",
        data: { token: raw.token, card },
      });
    }
  }

  /** 关闭飞书长连接，并阻止主动关闭期间的重连竞争。 */
  async disconnect(): Promise<void> {
    await this.channel.disconnect();
  }

  onMessage(handler: (message: FeishuInboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  /** 注册授权卡片回调处理器（PermissionBroker 在服务端校验管理员身份）。 */
  onApproval(handler: (params: { value: Record<string, unknown>; action: { messageId: string; chatId: string; operatorOpenId: string } }) => Promise<void>): void {
    this.approvalHandler = handler;
  }

  /** 向指定会话发送一张卡片，返回 messageId。 */
  async sendCardToChat(chatId: string, card: object): Promise<string> {
    const result = await this.channel.send(chatId, { card });
    return result.messageId;
  }

  /** 按 messageId 更新已发送的卡片。 */
  async updateCardById(messageId: string, card: object): Promise<void> {
    await this.channel.updateCard(messageId, card);
  }

  /** 按 messageId 撤回消息。 */
  async recallMessageById(messageId: string): Promise<void> {
    await this.client!.request({
      method: "DELETE",
      url: `/open-apis/im/v1/messages/${messageId}`,
    });
  }

  async startReply(message: FeishuInboundMessage): Promise<FeishuReply> {
    type CardController = { update(next: object | ((current: object) => object)): Promise<void>; messageId: string; current: object };
    let controller: CardController | undefined;
    let resolveController: ((value: CardController) => void) | undefined;
    let streamControllerResolve: (() => void) | undefined;
    const controllerReady = new Promise<CardController>((resolve) => {
      resolveController = resolve;
    });
    const streamPromise = this.channel.stream(message.context.chatId, {
      card: {
        initial: this.processingCard(""),  // 不显示"正在处理"，用 reaction 表情代替
        producer: async (streamController) => {
          controller = streamController;
          resolveController?.(streamController);
          await new Promise<void>((resolve) => {
            streamControllerResolve = resolve;
          });
        },
      },
    }, { replyTo: message.messageId, replyInThread: false });
    controller = await controllerReady;
    streamPromise.catch((error) => logger.error("[LarkTransport] CardKit 流式回复失败", error));
    return {
      update: (text) => controller!.update(this.processingCard(text)),
      close: async (text) => {
        await controller!.update(this.finalCard(text || "（无响应）"));
        streamControllerResolve?.();
        await streamPromise;
      },
    };
  }

  private processingCard(text: string): object {
    return { schema: "2.0", body: { elements: [{ tag: "markdown", content: text }] } };
  }

  private finalCard(text: string): object {
    return { schema: "2.0", body: { elements: [{ tag: "markdown", content: text }] } };
  }
}
