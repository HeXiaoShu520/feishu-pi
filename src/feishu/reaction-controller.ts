/**
 * 飞书处理中 reaction 控制器
 * 在处理消息时添加随机表情，完成后移除
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import { logger } from "../utils/logger.ts";

interface ReactionState {
  reactionId?: string;
  starting?: Promise<void>;
  stopRequested: boolean;
}

/** 随机表情池 - 只使用飞书支持的合法表情 */
const EMOJI_POOL = [
  "THINKING",
  "SMILE",
  "BLUSH",
  "OK",
  "THUMBSUP",
  "THANKS",
  "MUSCLE",
  "APPLAUSE",
  "DONE",
  "JIAYI",
  "LAUGH",
  "LOVE",
  "WINK",
  "PROUD",
  "SMART",
  "Fire",
  "Coffee",
  "Trophy",
  "CheckMark",
  "Hundred",
  "AWESOMEN",
  "LGTM",
  "Get",
  "Yes",
  "SALUTE",
  "HIGHFIVE",
  "Typing",
  "YouAreTheBest",
  "PARTY",
  "GIFT",
  "HEART",
  "ROSE",
];

/** 随机选择一个表情 */
function randomEmoji(): string {
  return EMOJI_POOL[Math.floor(Math.random() * EMOJI_POOL.length)];
}

/** 管理单条消息的处理中 reaction 生命周期 */
export class ReactionController {
  private readonly reactions = new Map<string, ReactionState>();
  private readonly client: Client;
  private readonly enabled: boolean;

  constructor(client: Client, enabled = true) {
    this.client = client;
    this.enabled = enabled;
  }

  /** 尝试添加处理中 reaction */
  async start(messageId: string): Promise<void> {
    if (!this.enabled) return;
    const current = this.reactions.get(messageId);
    if (current?.reactionId) return;
    if (current?.starting) {
      await current.starting;
      return;
    }
    const state: ReactionState = { stopRequested: false };
    state.starting = this.add(messageId, state);
    this.reactions.set(messageId, state);
    await state.starting;
  }

  /** 清理处理中 reaction */
  async stop(messageId: string): Promise<void> {
    const state = this.reactions.get(messageId);
    if (!state) return;
    state.stopRequested = true;
    if (state.starting) await state.starting;
    if (this.reactions.get(messageId) !== state) return;
    this.reactions.delete(messageId);
    if (state.reactionId) {
      try {
        await this.client.im.messageReaction.delete({
          path: { message_id: messageId, reaction_id: state.reactionId },
        });
      } catch (error) {
        logger.warn("移除飞书 reaction 失败:", error instanceof Error ? error.message : error);
      }
    }
  }

  /** 添加 reaction，并在 stop 抢先完成时补偿删除 */
  private async add(messageId: string, state: ReactionState): Promise<void> {
    try {
      const emojiType = randomEmoji();
      const response = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      state.reactionId = response.data?.reaction_id;
      if (state.stopRequested && state.reactionId) {
        await this.client.im.messageReaction.delete({
          path: { message_id: messageId, reaction_id: state.reactionId },
        });
      }
      if (state.stopRequested) this.reactions.delete(messageId);
    } catch (error) {
      logger.warn("添加飞书 reaction 失败:", error instanceof Error ? error.message : error);
      this.reactions.delete(messageId);
    }
  }
}
