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
  /** 普通文本回复的降级实现 */
  fallbackReply: FeishuReply;
  /** 是否启用 CardKit（默认 true） */
  enableCardKit?: boolean;
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
  private readonly fallbackReply: FeishuReply;
  private readonly enableCardKit: boolean;
  private readonly onError?: (err: unknown) => void;

  private stream?: CardKitStream;
  private cardId?: string;
  private useFallback = false;
  private closed = false;

  constructor(options: CardKitReplyOptions) {
    this.client = options.client;
    this.chatId = options.chatId;
    this.fallbackReply = options.fallbackReply;
    this.enableCardKit = options.enableCardKit ?? true;
    this.onError = options.onError;
  }

  async update(text: string): Promise<void> {
    if (this.closed) return;

    // 已降级，使用普通文本
    if (this.useFallback) {
      return this.fallbackReply.update(text);
    }

    // CardKit 未启用，直接降级
    if (!this.enableCardKit) {
      this.useFallback = true;
      return this.fallbackReply.update(text);
    }

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
      // CardKit 失败，降级为普通文本
      this.useFallback = true;
      return this.fallbackReply.update(text);
    }
  }

  async close(text: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // 使用降级，关闭普通文本回复
    if (this.useFallback || !this.stream) {
      return this.fallbackReply.close(text || "（无响应）");
    }

    try {
      // 关闭 CardKit 流式
      await this.stream.finalize(text);
    } catch (err) {
      this.onError?.(err);
      // 关闭失败，降级为普通文本
      return this.fallbackReply.close(text);
    }
  }

  /** 初始化 CardKit 流式卡片 */
  private async initializeCardKit(initialText: string): Promise<void> {
    // 创建流式卡片
    this.stream = new CardKitStream({
      client: this.client,
      onError: this.onError,
    });

    this.cardId = await this.stream.create(initialText);

    // 发送引用该卡片的消息
    await this.client.im.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: this.chatId,
        msg_type: "interactive",
        content: JSON.stringify({
          type: "card",
          data: {
            card_id: this.cardId,
          },
        }),
      },
    });
  }
}
