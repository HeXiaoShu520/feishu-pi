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
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.ts";

const CARD_SCHEMA = "2.0";
const STREAM_ELEMENT_ID = "stream_md";
const STATS_ELEMENT_ID = "stats_md";

interface CardKitStreamOptions {
  client: Client;
  /** 最小推送间隔（毫秒），默认 800ms */
  minPushIntervalMs?: number;
  /** 客户端打字机渲染速度（毫秒），默认 30ms */
  printFrequencyMs?: number;
  /** 每步推进的字符数，默认 3 */
  printStep?: number;
  /** 错误回调（用于降级日志） */
  onError?: (err: unknown) => void;
}

export class CardKitStream {
  private cardId?: string;
  private sequence = 0;
  private lastPushAt = 0;
  private accumulator = "";
  private disposed = false;
  private inFlight = false;
  private writeChain: Promise<void> = Promise.resolve();

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
      if (!cardId) {
        throw new Error(`Failed to get card_id from response: ${JSON.stringify(res)}`);
      }

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

    await this.enqueueWrite(() => this.pushUpdate(this.accumulator));
  }

  /** 替换全部内容（用于动画帧，不累加） */
  async replace(text: string): Promise<void> {
    if (this.disposed || !this.cardId) return;

    this.accumulator = text;
    await this.enqueueWrite(() => this.pushUpdate(text));
  }

  /** 关闭流式模式；statsText 在正文渲染完成后写入小字；renderWaitMsOverride 可覆盖渲染等待（分卡收尾时用短等待） */
  async finalize(fullText: string, statsText?: string, renderWaitMsOverride?: number): Promise<void> {
    if (this.disposed || !this.cardId) return;

    try {
      // 0. 最终内容必须覆盖所有尚未完成的流式更新
      this.accumulator = fullText;
      await this.enqueueWrite(() => this.pushUpdate(fullText));

      // 1. 等待客户端渲染完成（参考 Python 版本：min(3s, 文本长度 * 0.025)）
      const renderWaitMs = renderWaitMsOverride ?? Math.min(3000, fullText.length * 25);
      await new Promise(resolve => setTimeout(resolve, renderWaitMs));

      // 2. 正文渲染完成后写入统计小字（必须在关闭流式前，关闭后元素不能再更新）
      if (statsText) await this.enqueueWrite(() => this.putStats(statsText));

      // 3. 关闭流式模式（不再发送最终内容，避免覆盖正在渲染的文本）
      await this.enqueueWrite(() => this.patchSettings(false));

      this.disposed = true;
    } catch (err) {
      this.onError?.(err);
      throw err;
    }
  }

  /** 当前卡片累积的正文内容（供分卡时切分）。 */
  getContent(): string {
    return this.accumulator;
  }

  /** 流式更新元素内容（全量文本） */
  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(task);
    this.writeChain = next.catch((err) => {
      this.onError?.(err);
    });
    return next;
  }

  private async pushUpdate(fullText: string): Promise<void> {
    if (!this.cardId || this.disposed) return;

    this.inFlight = true;
    try {
      await this.putContent(fullText);
      this.lastPushAt = Date.now();
    } catch (err) {
      // 官方约 10 分钟会关闭卡片流式模式，PUT 会失败：报错误并重新开启流式后重试一次
      this.onError?.(err);
      logger.error(`[CardKit] 流式更新失败（卡片流式模式可能已被官方关闭），尝试重新开启: ${err instanceof Error ? err.message : err}`);
      try {
        await this.patchSettings(true);
        await this.putContent(fullText);
        logger.warn(`[CardKit] 已重新开启流式模式，恢复更新成功`);
        this.lastPushAt = Date.now();
      } catch (retryErr) {
        this.onError?.(retryErr);
        logger.error(`[CardKit] 重新开启流式后仍更新失败，内容继续累积: ${retryErr instanceof Error ? retryErr.message : retryErr}`);
        // 不抛出，继续累积
      }
    } finally {
      this.inFlight = false;
    }
  }

  /** PUT 正文元素内容（content 不允许为空串，空时用空格占位）。 */
  private putContent(fullText: string): Promise<void> {
    return this.client.request({
      method: "PUT",
      url: `/open-apis/cardkit/v1/cards/${this.cardId}/elements/${STREAM_ELEMENT_ID}/content`,
      data: {
        content: fullText || " ",
        sequence: ++this.sequence,
        uuid: this.uuid(),
      },
    }).then(() => undefined);
  }

  /** 更新独立的统计小字元素。 */
  async updateStats(text: string): Promise<void> {
    if (this.disposed || !this.cardId) return;
    try {
      await this.enqueueWrite(() => this.putStats(text));
    } catch (err) {
      this.onError?.(err);
    }
  }

  /** 实际推送小字元素内容（内部复用）。 */
  private async putStats(text: string): Promise<void> {
    await this.client.request({
      method: "PUT",
      url: `/open-apis/cardkit/v1/cards/${this.cardId}/elements/${STATS_ELEMENT_ID}/content`,
      data: { content: text, sequence: ++this.sequence, uuid: this.uuid() },
    });
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
          {
            tag: "markdown",
            content: " ",
            text_size: "notation",
            element_id: STATS_ELEMENT_ID,
          },
        ],
      },
    });
  }

  private uuid(): string {
    return randomUUID();
  }
}
