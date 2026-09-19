/**
 * 基于 CardKit 流式卡片的回复实现（只用 CardKit，不做文本降级）。
 *
 * 分卡策略：正文累积超过 maxCardChars 后，在完整块边界（段落空行且不在代码围栏内）
 * 切开——旧卡流式收尾，剩余内容开一张新卡继续，保证任何一块都不会从中间被隔断。
 * 精简模式下工具调用是临时显示（会被覆盖），正文增长慢，几乎不会触发分卡。
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuReply } from "./types.ts";
import { CardKitStream } from "./cardkit-stream.ts";
import { logger } from "../utils/logger.ts";

export interface CardKitReplyOptions {
  client: Client;
  chatId: string;
  messageId?: string;
  /** 是否以话题形式回复（由会话模式决定，见 resolveReplyInThread） */
  replyInThread?: boolean;
  onError?: (err: unknown) => void;
  /** 单张卡片的正文字符上限，超过后分新卡（默认 10000，保证可读性） */
  maxCardChars?: number;
}

/**
 * 决定回复是否以话题（thread）形式发出。
 *
 * 飞书 reply 接口的语义：reply_in_thread 仅在话题群生效——
 * - true：回复进入被回复消息所在的话题（被回复消息是话题根时同样进入该话题）；
 * - false：在话题群里会以回复内容为根**开出一个新话题**。
 *
 * 因此不能用「消息有没有 threadId」来判定：话题群的话题根消息（用户新开话题的第一条）
 * 恰好没有 threadId，按 threadId 判定会让机器人的回答脱离用户的话题、另开新话题。
 * 正确规则：
 * - 话题群：一律 true（含话题根）；
 * - 私聊/普通群：跟随消息自身所在线程——消息在线程内（有 threadId）则回线程内，否则普通回复。
 */
export function resolveReplyInThread(chatMode: "p2p" | "group" | "topic" | undefined, threadId?: string): boolean {
  return chatMode === "topic" || !!threadId;
}

/**
 * 在文本中寻找最后一个安全的块边界（"\n\n"），要求该位置之前代码围栏（```）成对出现，
 * 即切分点不在代码块/行内代码中间。找不到返回 -1。
 */
export function findBlockBoundary(text: string): number {
  let index = text.lastIndexOf("\n\n");
  while (index > 0) {
    const fences = (text.slice(0, index).match(/```/g) || []).length;
    if (fences % 2 === 0) return index + 2; // 围栏成对，边界在块外
    index = text.lastIndexOf("\n\n", index - 1);
  }
  return -1;
}

/**
 * CardKit 流式回复包装器
 * - 启用时使用 CardKit 流式卡片
 * - 正文过长自动分卡（完整块边界切分）
 * - 失败上报，不自动降级为普通文本消息
 */
export class CardKitReply implements FeishuReply {
  private readonly client: Client;
  private readonly chatId: string;
  private readonly messageId?: string;
  /** 本轮卡片消息的 message_id（sendCardReference 时记录），撤回用 */
  private sentMessageId?: string;
  private readonly replyInThread: boolean;
  private readonly onError?: (err: unknown) => void;
  private readonly maxCardChars: number;

  private stream?: CardKitStream;
  private closed = false;
  private initialization?: Promise<void>;
  /** 当前卡片内容在全文中的起始偏移（分卡时推进） */
  private offset = 0;
  /** 分卡串行化，避免并发旋转 */
  private rotating?: Promise<void>;

  constructor(options: CardKitReplyOptions) {
    this.client = options.client;
    this.chatId = options.chatId;
    this.messageId = options.messageId;
    this.replyInThread = options.replyInThread ?? false;
    this.onError = options.onError;
    this.maxCardChars = options.maxCardChars ?? 10000;
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
      await this.maybeRotate();
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

  /** 替换展示内容但不改动内容累积器（思考动画帧专用）：避免 spinner 文本混入后续正文增量 */
  async replaceVisual(text: string): Promise<void> {
    if (this.closed) return;

    try {
      if (!this.stream) {
        await this.initializeCardKit(text);
        return;
      }

      await this.stream.replaceVisual(text);
    } catch (err) {
      this.onError?.(err);
      throw err;
    }
  }

  async updateStats(text: string): Promise<void> {
    if (this.closed || !this.stream) return;
    await this.stream.updateStats(text);
  }

  /** 关闭回复；statsText 可选，正文渲染完成后写入小字 */
  async close(text: string, statsText?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (!this.stream) {
      // 没有初始化过，创建后立即走关闭流程
      await this.initializeCardKit(text);
    }

    try {
      // 最后一张卡只关闭自己承载的那段内容（前面几张已在分卡时收尾）
      const stream = this.stream!;
      await stream.finalize(text.slice(this.offset), statsText);
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

      const cardId = await this.stream.create(initialText);

      // 发送引用该卡片的消息
      await this.sendCardReference(cardId, this.messageId);
    })();

    try {
      await this.initialization;
    } catch (error) {
      this.stream?.dispose();
      this.stream = undefined;
      this.initialization = undefined;
      throw error;
    }
  }

  /** 发送引用 card_id 的卡片消息（回复原消息或直接发送）。记录发出的消息 id 供撤回用。 */
  private async sendCardReference(cardId: string, replyToMessageId?: string): Promise<void> {
    if (replyToMessageId) {
      const res = await this.client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          msg_type: "interactive",
          content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
          reply_in_thread: this.replyInThread,
        },
      });
      this.sentMessageId = res?.data?.message_id;
    } else {
      const res = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: this.chatId,
          msg_type: "interactive",
          content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
        },
      });
      this.sentMessageId = res?.data?.message_id;
    }
  }

  /** 撤回本条卡片消息（本轮被打断时调用；未发出过消息则无操作）。 */
  async recall(): Promise<void> {
    this.closed = true;
    this.stream?.dispose();
    if (!this.sentMessageId) return;
    await this.client.im.v1.message.delete({ path: { message_id: this.sentMessageId } });
    this.sentMessageId = undefined;
  }

  /** 正文超过单卡上限时，在完整块边界分出新卡。 */
  private async maybeRotate(): Promise<void> {
    if (!this.stream || this.rotating) return;
    const content = this.stream.getContent();
    if (content.length < this.maxCardChars) return;

    const split = findBlockBoundary(content);
    if (split <= 0) {
      // 找不到安全的块边界（如整段巨长文本），继续累积，等下一个边界出现再切
      logger.warn(`[CardKit] 正文已超 ${this.maxCardChars} 字符但暂无安全块边界，继续等待`);
      return;
    }

    this.rotating = (async () => {
      const head = content.slice(0, split);
      const tail = content.slice(split);
      const oldStream = this.stream!;

      // 旧卡流式收尾（关流式后全文即时呈现，无需渲染等待）
      await oldStream.finalize(head);

      // 新卡承载剩余内容
      const newStream = new CardKitStream({ client: this.client, onError: this.onError });
      const newCardId = await newStream.create(tail);
      await newStream.replace(tail);
      this.stream = newStream;
      this.offset += split;
      await this.sendCardReference(newCardId, this.messageId);
      logger.info(`[CardKit] 正文超限已分卡：前卡 ${head.length} 字符，新卡从第 ${this.offset} 字符继续`);
    })();

    try {
      await this.rotating;
    } finally {
      this.rotating = undefined;
    }
  }
}
