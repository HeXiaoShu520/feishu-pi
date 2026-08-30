/**
 * CardKit Schema 2.0 流式卡片实现
 *
 * 官方流程：
 * 1. POST /open-apis/cardkit/v1/cards 创建卡片实体（streaming_mode: true）
 * 2. 发送消息引用 card_id
 * 3. PUT /cards/:card_id/elements/:element_id/content 流式更新（全量文本）
 * 4. PATCH /cards/:card_id/settings 关闭流式模式
 * 5. PUT /cards/:card_id 最终内容
 */

import type { Client } from "@larksuiteoapi/node-sdk";

const CARD_SCHEMA = "2.0";
const STREAM_ELEMENT_ID = "stream_md";

interface CardKitStreamOptions {
  client: Client;
  /** 最小推送间隔（毫秒），默认 800ms */
  minPushIntervalMs?: number;
  /** 客户端打字机渲染速度（毫秒），默认 120ms */
  printFrequencyMs?: number;
  /** 打字机步进（字符数），默认 3 */
  printStep?: number;
  onError?: (err: unknown) => void;
}

export interface CardKitHandle {
  cardId: string;
  /** 累积文本并推送更新 */
  patch(delta: string): Promise<void>;
  /** 关闭流式，发送最终内容 */
  finalize(fullText: string): Promise<void>;
  /** 降级为普通文本（CardKit 失败时） */
  fallbackText?: (text: string) => Promise<void>;
}

export class CardKitStream {
  private cardId?: string;
  private sequence = 0;
  private lastPushAt = 0;
  private accumulator = "";
  private disposed = false;
  private inFlight = false;

  private readonly client: Client;
  private readonly minInterval: number;
  private readonly printFrequencyMs: number;
  private readonly printStep: number;
  private readonly onError?: (err: unknown) => void;

  constructor(options: CardKitStreamOptions) {
    this.client = options.client;
    this.minInterval = options.minPushIntervalMs ?? 800;
    this.printFrequencyMs = options.printFrequencyMs ?? 30; // 加快客户端渲染：30ms/步
    this.printStep = options.printStep ?? 3;
    this.onError = options.onError;
  }

  /** 创建卡片实体并返回 card_id */
  async create(initialText = " "): Promise<string> {
    if (this.cardId) throw new Error("CardKit stream already created");

    try {
      const cardJson = this.buildCardJson(initialText, true);
      const res = await this.client.request({
        method: "POST",
        url: "/open-apis/cardkit/v1/cards",
        data: {
          type: "card_json",
          data: cardJson,
        },
      });

      const cardId = (res as any)?.data?.card_id;
      if (!cardId) throw new Error("Failed to get card_id from response");

      this.cardId = cardId;
      this.sequence = 1;
      return cardId;
    } catch (err) {
      this.onError?.(err);
      throw err;
    }
  }

  /** 累积增量文本并推送 */
  async patch(delta: string): Promise<void> {
    if (this.disposed || !this.cardId) return;

    this.accumulator += delta;
    const now = Date.now();

    // 节流：距离上次推送未超过最小间隔，跳过
    if (this.inFlight || now - this.lastPushAt < this.minInterval) {
      return;
    }

    await this.pushUpdate(this.accumulator);
  }

  /** 替换全部内容（用于动画帧，不累加） */
  async replace(text: string): Promise<void> {
    if (this.disposed || !this.cardId) return;

    this.accumulator = text;
    await this.pushUpdate(text);
  }

  /** 关闭流式模式 */
  async finalize(fullText: string): Promise<void> {
    if (this.disposed || !this.cardId) return;

    try {
      // 0. 等待最后一次推送完成，并强制推送 accumulator 里的剩余内容
      while (this.inFlight) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // 如果 accumulator 还有未推送的内容，立即推送
      if (this.accumulator) {
        await this.pushUpdate(this.accumulator);
      }

      // 1. 等待客户端渲染完成（参考 Python 版本：min(3s, 文本长度 * 0.025)）
      const renderWaitMs = Math.min(3000, fullText.length * 25);
      await new Promise(resolve => setTimeout(resolve, renderWaitMs));

      // 2. 关闭流式模式（不再发送最终内容，避免覆盖正在渲染的文本）
      await this.patchSettings(false);

      this.disposed = true;
    } catch (err) {
      this.onError?.(err);
      throw err;
    }
  }

  /** 流式更新元素内容（全量文本） */
  private async pushUpdate(fullText: string): Promise<void> {
    if (!this.cardId || this.disposed) return;

    this.inFlight = true;
    try {
      await this.client.request({
        method: "PUT",
        url: `/open-apis/cardkit/v1/cards/${this.cardId}/elements/${STREAM_ELEMENT_ID}/content`,
        data: {
          content: fullText,
          sequence: ++this.sequence,
          uuid: this.uuid(),
        },
      });
      this.lastPushAt = Date.now();
    } catch (err) {
      this.onError?.(err);
      // 不抛出，继续累积
    } finally {
      this.inFlight = false;
    }
  }

  /** 关闭或开启流式模式 */
  private async patchSettings(streaming: boolean): Promise<void> {
    if (!this.cardId) return;

    try {
      await this.client.request({
        method: "PATCH",
        url: `/open-apis/cardkit/v1/cards/${this.cardId}/settings`,
        data: {
          settings: JSON.stringify({
            config: { streaming_mode: streaming },
          }),
          sequence: ++this.sequence,
          uuid: this.uuid(),
        },
      });
    } catch (err) {
      // 关闭流式失败不影响最终内容发送
      this.onError?.(err);
    }
  }

  /** 构建 CardKit JSON */
  private buildCardJson(text: string, streaming: boolean): string {
    return JSON.stringify({
      schema: CARD_SCHEMA,
      config: {
        update_multi: true,
        ...(streaming
          ? {
              streaming_mode: true,
              streaming_config: {
                print_frequency_ms: { default: this.printFrequencyMs },
                print_step: { default: this.printStep },
                print_strategy: "fast",
              },
            }
          : {
              streaming_mode: false,
            }),
      },
      body: {
        elements: [
          {
            tag: "markdown",
            content: text || " ",
            element_id: STREAM_ELEMENT_ID,
          },
        ],
      },
    });
  }

  private uuid(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}
