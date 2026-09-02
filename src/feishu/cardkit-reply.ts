/**
 * 基于 CardKit 流式卡片的回复实现
 * 失败时自动降级为普通文本消息
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuReply } from "./types.ts";
import { CardKitStream } from "./cardkit-stream.ts";

export interface CardKitReplyOptions {
  client: Client;
  chatId: string;
  messageId?: string;
  threadId?: string;
  onError?: (err: unknown) => void;
}

/**
 * CardKit 流式回复包装器
 * - 启用时使用 CardKit 流式卡片
 * - 失败时自动降级为普通文本消息
 */
export class CardKitReply implements FeishuReply {
  private readonly client: Client;
  private readonly chatId: string;
  private readonly messageId?: string;
  private readonly threadId?: string;
  private readonly onError?: (err: unknown) => void;

  private stream?: CardKitStream;
  private cardId?: string;
  private closed = false;
  private initialization?: Promise<void>;

  constructor(options: CardKitReplyOptions) {
    this.client = options.client;
    this.chatId = options.chatId;
    this.messageId = options.messageId;
    this.threadId = options.threadId;
    this.onError = options.onError;
  }

  async update(text: string): Promise<void> {
    if (this.closed) return;

    try {
      // 首次更新：创建卡片并发送消息
      if (!this.stream) {
        await this.initializeCardKit(text);
        return;
      }

      // 后续更新：推送增量
      await this.stream.patch(text);
    } catch (err) {
      this.onError?.(err);
      throw err;
    }
  }

  /** 替换卡片内容（不累加，用于动画） */
  async replace(text: string): Promise<void> {
    if (this.closed) return;

    try {
      if (!this.stream) {
        await this.initializeCardKit(text);
        return;
      }

      await this.stream.replace(text);
    } catch (err) {
      this.onError?.(err);
      throw err;
    }
  }

  async updateStats(text: string): Promise<void> {
    if (this.closed || !this.stream) return;
    await this.stream.updateStats(text);
  }

  async close(text: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (!this.stream) {
      // 没有初始化过，创建并立即关闭
      await this.initializeCardKit(text);
    }

    try {
      await this.stream!.finalize(text);
    } catch (err) {
      this.onError?.(err);
      throw err;
    }
  }

  /** 初始化 CardKit 流式卡片 */
  private async initializeCardKit(initialText: string): Promise<void> {
    if (this.initialization) return this.initialization;

    this.initialization = (async () => {
      // 创建流式卡片
      this.stream = new CardKitStream({
        client: this.client,
        onError: this.onError,
      });

      this.cardId = await this.stream.create(initialText);

      // 发送引用该卡片的消息
      if (this.messageId) {
        // 使用 reply 方法回复消息
        await this.client.im.message.reply({
          path: { message_id: this.messageId },
          data: {
            msg_type: "interactive",
            content: JSON.stringify({ type: "card", data: { card_id: this.cardId } }),
            reply_in_thread: !!this.threadId,
          },
        });
      } else {
        // 没有 messageId 时使用 create 发送普通消息
        await this.client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: this.chatId,
            msg_type: "interactive",
            content: JSON.stringify({ type: "card", data: { card_id: this.cardId } }),
          },
        });
      }
    })();

    try {
      await this.initialization;
    } catch (error) {
      this.initialization = undefined;
      throw error;
    }
  }
}
