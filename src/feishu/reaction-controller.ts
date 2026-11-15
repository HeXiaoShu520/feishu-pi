/**
 * 收到消息时的表情回应。
 *
 * 真人不会对每条消息都点表情，也不会加一个和内容无关的随机表情。
 * 这里按正文语义选一个相关表情，并按概率决定要不要加；加上后保留，
 * 像真人随手回了个表情，而不是「处理中」的状态灯。
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import { logger } from "../utils/logger.ts";

interface ReactionState {
  reactionId?: string;
  starting?: Promise<void>;
}

/** 按正文语义选一个飞书原生表情；匹配不到就用 SMILE。 */
export function pickReaction(text: string): string {
  if (/[?？]|怎么|为什么|如何|能不能|可不可以|帮我|看看/.test(text)) return "THINKING";
  if (/哈哈|笑死|草|梗|乐/.test(text)) return "LAUGH";
  if (/好看|厉害|棒|牛|强|喜欢|爱你/.test(text)) return "BLUSH";
  if (/无语|离谱|服了|醉了|尴尬|啊这/.test(text)) return "SPEECHLESS";
  if (/累|困|难过|哭|烦|崩|寄了/.test(text)) return "COMFORT";
  if (/晚安|睡了|早|下班/.test(text)) return "SLEEP";
  if (/谢谢|感谢|辛苦/.test(text)) return "THANKS";
  if (/[!！]{2,}|卧槽|我去|真的假的/.test(text)) return "WOW";
  return "SMILE";
}

export class ReactionController {
  private readonly reactions = new Map<string, ReactionState>();
  private readonly client: Client;
  private readonly enabled: boolean;
  private readonly probability: number;

  constructor(client: Client, enabled = true, probability = 0.5) {
    this.client = client;
    this.enabled = enabled;
    this.probability = probability;
  }

  /** 按概率给这条消息加一个语义相关的表情；加上后不撤回。 */
  async start(messageId: string, text = ""): Promise<void> {
    if (!this.enabled || Math.random() > this.probability) return;
    if (this.reactions.has(messageId)) return;
    const state: ReactionState = {};
    state.starting = this.add(messageId, text, state);
    this.reactions.set(messageId, state);
    await state.starting;
  }

  /** 本轮结束：只清本地状态，表情留在对方消息上。 */
  async stop(messageId: string): Promise<void> {
    const state = this.reactions.get(messageId);
    if (!state) return;
    if (state.starting) await state.starting;
    this.reactions.delete(messageId);
  }

  private async add(messageId: string, text: string, state: ReactionState): Promise<void> {
    try {
      const response = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: pickReaction(text) } },
      });
      state.reactionId = response.data?.reaction_id;
    } catch (error) {
      logger.warn("添加飞书 reaction 失败:", error instanceof Error ? error.message : error);
      this.reactions.delete(messageId);
    }
  }
}
