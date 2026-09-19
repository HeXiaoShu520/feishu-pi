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
/** 状态栏空态占位字符（盲文空位 U+2800）：不可见但保留一行高度，避免状态栏忽隐忽现导致卡片跳动 */
export const STATS_PLACEHOLDER = "\u2800";

interface CardKitStreamOptions {
  client: Client;
  /** 最小推送间隔（毫秒），默认 400ms：帧小而频繁，客户端打字机不追帧、观感连贯 */
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
  /** 周期刷新定时器：每 tick 把累积器里没上屏的内容推给卡片（简化节流：不存在丢帧/饿死问题） */
  private flushTimer?: NodeJS.Timeout;
  private dirty = false;

  private readonly client: Client;
  private readonly minInterval: number;
  private readonly printFrequencyMs: number;
  private readonly printStep: number;
  private readonly onError?: (err: unknown) => void;

  constructor(options: CardKitStreamOptions) {
    this.client = options.client;
    this.minInterval = options.minPushIntervalMs ?? 400;
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

      const cardId = (res as { data?: { card_id?: string } } | undefined)?.data?.card_id;
      if (!cardId) {
        throw new Error(`Failed to get card_id from response: ${JSON.stringify(res)}`);
      }

      this.cardId = cardId;
      this.sequence = 1;
      // 周期刷新：每 minInterval 把未上屏的累积内容推一次（在途时跳过本 tick，下个 tick 补上）
      this.flushTimer = setInterval(() => this.flushTick(), this.minInterval);
      return cardId;
    } catch (err) {
      this.onError?.(err);
      throw err;
    }
  }

  /** 累积增量文本：只标脏，由周期刷新定时器统一定时推给卡片 */
  patch(delta: string): void {
    if (this.disposed || !this.cardId) return;
    this.accumulator += delta;
    this.dirty = true;
  }

  /** 周期刷新 tick：有未上屏的新内容就推（在途时跳过本 tick，下个 tick 自然补上） */
  private flushTick(): void {
    if (this.disposed || !this.cardId || !this.dirty || this.inFlight) return;
    this.dirty = false;
    void this.enqueueWrite(() => this.pushUpdate(this.accumulator));
  }

  /** 替换全部内容（用于正文渲染，立即推送） */
  async replace(text: string): Promise<void> {
    if (this.disposed || !this.cardId) return;

    this.accumulator = text;
    this.dirty = false;
    await this.enqueueWrite(() => this.pushUpdate(text));
  }

  /** 替换展示内容但不改动内容累积器（动画帧专用）：spinner 文本不污染正文，首个真实内容整体覆盖 */
  async replaceVisual(text: string): Promise<void> {
    if (this.disposed || !this.cardId) return;
    await this.enqueueWrite(() => this.pushUpdate(text));
  }

  /**
   * 收尾时序：推最终全文 + 统计小字（小字紧跟最终帧入队，打字机打尾字时小字同步出现）→
   * 等 3s 让客户端处理完 → 关流式。
   */
  async finalize(fullText: string, statsText?: string): Promise<void> {
    if (this.disposed || !this.cardId) return;

    try {
      this.accumulator = fullText;
      // 1. 推最终全文 + 统计小字（流式仍开，两笔元素 PUT 背靠背入队，写队列保证先后）
      await this.enqueueWrite(() => this.pushUpdate(fullText));
      if (statsText) {
        await this.enqueueWrite(async () => {
          // 小字失败不阻断收尾：重试一次，仍失败则记日志放弃（缺小字好过卡片卡在"生成中"）
          try {
            await this.putStats(statsText);
          } catch (err) {
            this.onError?.(err);
            await new Promise((resolve) => setTimeout(resolve, 500));
            await this.putStats(statsText).catch((retryErr) => this.onError?.(retryErr));
          }
        });
      }
      // 2. 等 3s，给客户端处理小字元素的余量
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      // 3. 关流式
      await this.enqueueWrite(() => this.patchSettings(false));
      this.disposed = true;
      clearInterval(this.flushTimer);
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

  /** 更新独立的统计小字元素（工具执行期间的动画/状态文案）。 */
  async updateStats(text: string): Promise<void> {
    if (this.disposed || !this.cardId) return;
    await this.enqueueWrite(() => this.putStats(text));
  }

  /** 实际推送小字元素内容（内部复用）。 */
  private async putStats(text: string): Promise<void> {
    await this.client.request({
      method: "PUT",
      url: `/open-apis/cardkit/v1/cards/${this.cardId}/elements/${STATS_ELEMENT_ID}/content`,
      data: { content: text, sequence: ++this.sequence, uuid: this.uuid() },
    });
  }

  /** 卡片级全量更新：整卡 JSON 一次写入（含正文与统计小字），即时渲染。
   *  实测形状：{ card: { type: "card_json", data: <卡片JSON字符串> }, sequence, uuid } */
  private async putFinalCard(fullText: string, statsText?: string): Promise<void> {
    await this.client.request({
      method: "PUT",
      url: `/open-apis/cardkit/v1/cards/${this.cardId}`,
      data: {
        card: { type: "card_json", data: this.buildCardJson(fullText, false, statsText) },
        sequence: ++this.sequence,
        uuid: this.uuid(),
      },
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
  private buildCardJson(text: string, streaming: boolean, statsText?: string): string {
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
            content: statsText || STATS_PLACEHOLDER,
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
