/**
 * 群聊唤醒判定：一条没有 @ 机器人的群消息，要不要接话。
 *
 * 真人不会对群里每句话都响应。默认潜水，只在被叫名字、像在提问、或偶尔
 * 有人甩图时接一句；主动接话有冷却和每小时上限，避免刷屏和模型调用失控。
 * 被 @ 的消息由传输层直接放行，不经过这里。
 */

/** 中文里"像在提问"的粗略特征。 */
const QUESTION = /[?？]|怎么|为什么|为啥|如何|是不是|能不能|可不可以|有没有|谁|哪儿|哪里|何时|多少/;

export interface GroupWakerOptions {
  /** 总开关；关闭后群聊只响应 @。 */
  enabled?: boolean;
  /** 被叫到这些名字时必醒。 */
  names?: string[];
  /** 普通消息接话概率。 */
  probability?: number;
  /** 提问接话概率。 */
  questionProbability?: number;
  /** 图片消息接话概率（斗图场景）。 */
  imageProbability?: number;
  /** 主动接话后的冷却时间。 */
  cooldownMs?: number;
  /** 每个群每小时的主动接话上限。 */
  hourlyLimit?: number;
  /** 深夜（本地时间）不主动接话；点名不受限。 */
  quietFrom?: number;
  quietTo?: number;
  /** 同一群里重复点名的忽略窗口。 */
  nameRepeatMs?: number;
  now?: () => number;
  random?: () => number;
}

export interface WakeInput {
  chatId: string;
  text: string;
  hasImage?: boolean;
}

export interface WakeDecision {
  wake: boolean;
  reason: string;
}

interface ChatState {
  cooldownUntil: number;
  hourKey: string;
  hourCount: number;
  lastNameWakeAt: number;
}

export class GroupWaker {
  private readonly enabled: boolean;
  private readonly names: string[];
  private readonly probability: number;
  private readonly questionProbability: number;
  private readonly imageProbability: number;
  private readonly cooldownMs: number;
  private readonly hourlyLimit: number;
  private readonly quietFrom: number;
  private readonly quietTo: number;
  private readonly nameRepeatMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly states = new Map<string, ChatState>();

  constructor(options: GroupWakerOptions = {}) {
    this.enabled = options.enabled !== false;
    this.names = options.names ?? ["大肥鱼", "肥鱼", "鲸鱼娘", "小鲸鱼"];
    this.probability = options.probability ?? 0.02;
    this.questionProbability = options.questionProbability ?? 0.12;
    this.imageProbability = options.imageProbability ?? 0.15;
    this.cooldownMs = options.cooldownMs ?? 10 * 60_000;
    this.hourlyLimit = options.hourlyLimit ?? 3;
    this.quietFrom = options.quietFrom ?? 1;
    this.quietTo = options.quietTo ?? 7;
    this.nameRepeatMs = options.nameRepeatMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  decide(input: WakeInput): WakeDecision {
    if (!this.enabled) return { wake: false, reason: "disabled" };
    const text = input.text.trim();
    if (!text && !input.hasImage) return { wake: false, reason: "empty" };
    const now = this.now();
    const state = this.state(input.chatId);

    // 被叫名字：优先回应；同一群里一分钟内重复叫只接一次，避免复读。
    const name = this.names.find((item) => text.includes(item));
    if (name) {
      if (now - state.lastNameWakeAt < this.nameRepeatMs) return { wake: false, reason: `name-repeat:${name}` };
      state.lastNameWakeAt = now;
      return { wake: true, reason: `name:${name}` };
    }

    if (this.isQuiet(now)) return { wake: false, reason: "quiet-hours" };
    if (now < state.cooldownUntil) return { wake: false, reason: "cooldown" };

    const hourKey = this.hourKey(now);
    if (state.hourKey !== hourKey) {
      state.hourKey = hourKey;
      state.hourCount = 0;
    }
    if (state.hourCount >= this.hourlyLimit) return { wake: false, reason: "hourly-limit" };

    const chance = input.hasImage ? this.imageProbability : QUESTION.test(text) ? this.questionProbability : this.probability;
    if (this.random() >= chance) return { wake: false, reason: "dice" };

    state.hourCount += 1;
    state.cooldownUntil = now + this.cooldownMs;
    return { wake: true, reason: input.hasImage ? "image" : QUESTION.test(text) ? "question" : "chance" };
  }

  /** 兼容布尔用法；需要日志时用 decide。 */
  shouldWake(input: WakeInput): boolean {
    return this.decide(input).wake;
  }

  private state(chatId: string): ChatState {
    let state = this.states.get(chatId);
    if (!state) {
      state = { cooldownUntil: 0, hourKey: "", hourCount: 0, lastNameWakeAt: 0 };
      this.states.set(chatId, state);
    }
    return state;
  }

  private isQuiet(now: number): boolean {
    const hour = new Date(now).getHours();
    return this.quietFrom <= this.quietTo
      ? hour >= this.quietFrom && hour < this.quietTo
      : hour >= this.quietFrom || hour < this.quietTo;
  }

  private hourKey(now: number): string {
    const date = new Date(now);
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}-${date.getHours()}`;
  }
}
