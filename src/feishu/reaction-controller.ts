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

/** 随机表情池 - 预制全套飞书表情（emoji_type 命名与飞书一致） */
const EMOJI_POOL = [
  "OK", "THUMBSUP", "THANKS", "MUSCLE", "FINGERHEART", "APPLAUSE", "FISTBUMP", "JIAYI", "DONE", "SMILE",
  "BLUSH", "LAUGH", "SMIRK", "LOL", "FACEPALM", "LOVE", "WINK", "PROUD", "WITTY", "SMART",
  "SCOWL", "THINKING", "SOB", "CRY", "ERROR", "NOSEPICK", "HAUGHTY", "SLAP", "SPITBLOOD", "TOASTED",
  "GLANCE", "DULL", "INNOCENTSMILE", "JOYFUL", "WOW", "TRICK", "YEAH", "ENOUGH", "TEARS", "EMBARRASSED",
  "KISS", "SMOOCH", "DROOL", "OBSESSED", "MONEY", "TEASE", "SHOWOFF", "COMFORT", "CLAP", "PRAISE",
  "STRIVE", "XBLUSH", "SILENT", "WAVE", "WHAT", "FROWN", "SHY", "DIZZY", "LOOKDOWN", "CHUCKLE",
  "WAIL", "CRAZY", "WHIMPER", "HUG", "BLUBBER", "WRONGED", "HUSKY", "SHHH", "SMUG", "ANGRY",
  "HAMMER", "SHOCKED", "TERROR", "PETRIFIED", "SKULL", "SWEAT", "SPEECHLESS", "SLEEP", "DROWSY", "YAWN",
  "SICK", "PUKE", "BETRAYED", "HEADSET", "EatingFood", "MeMeMe", "Sigh", "Typing", "Lemon", "Get",
  "LGTM", "OnIt", "OneSecond", "VRHeadset", "YouAreTheBest", "Yes", "No", "OKR", "CheckMark", "CrossMark",
  "MinusOne", "Hundred", "AWESOMEN", "Pin", "BeamingFace", "Delighted", "ColdSweat", "FullMoonFace", "Partying", "GoGoGo",
  "ThanksFace", "SaluteFace", "Shrug", "ClownFace", "HappyDragon",
];

/** 随机选择一个表情 */
function randomEmoji(): string {
  return EMOJI_POOL[Math.floor(Math.random() * EMOJI_POOL.length)];
}

/**
 * 管理单条消息的"处理中"reaction 生命周期（开始时加随机表情，结束后移除）。
 * start/stop 可能乱序并发（消息极快处理完时 stop 先于加表情到达），
 * 用 starting promise 与 stopRequested 标记协调：加上了就补删，还没加上就登记待删。
 */
export class ReactionController {
  private readonly reactions = new Map<string, ReactionState>();
  private readonly client: Client;
  private readonly enabled: boolean;

  constructor(client: Client, enabled = true) {
    this.client = client;
    this.enabled = enabled;
  }

  /** 开始处理：为消息加一个随机表情（已有表情或正在加则直接等待完成）。 */
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

  /** 处理结束：移除表情并清理状态（表情尚未加上时由 add 完成后补偿删除）。 */
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
