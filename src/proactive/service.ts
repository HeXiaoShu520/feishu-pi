/**
 * 群聊主动发言：只在 env 指定的群里，群安静一段时间后，结合最近聊天说一句。
 *
 * 不是定时问候，也不是轮询刷屏：每个群有安静时长、两次发言冷却、每日上限、
 * 深夜静默和随机概率；模型判断没有自然想接的话就输出 [SKIP]，服务不发送。
 * 发送、生成、读取最近消息全部由调用方注入，服务本身不依赖飞书。
 */

export interface ProactiveMessage {
  name: string;
  text: string;
  at: number;
  self?: boolean;
}

export interface ProactiveSnapshot {
  chatId: string;
  lastAt: number;
  messages: ProactiveMessage[];
}

export interface ProactiveDeps {
  /** 读取该群最近消息；没有记录返回 undefined */
  recent(chatId: string): ProactiveSnapshot | undefined;
  /** 结合最近聊天生成一句；返回 [SKIP] 表示这次不说话 */
  generate(snapshot: ProactiveSnapshot): Promise<string>;
  send(chatId: string, text: string): Promise<void>;
  /** 记录自己刚说的话，推进该群最后活动时间 */
  recordSelf(chatId: string, text: string): void;
}

export interface ProactiveOptions {
  enabled?: boolean;
  /** 允许主动发言的群 chatId */
  chats: string[];
  /** 群安静多久后考虑发言，默认 45 分钟 */
  idleMs?: number;
  /** 两次主动发言/尝试之间的冷却，默认 3 小时 */
  cooldownMs?: number;
  /** 每群每天最多主动发言次数，默认 2 */
  dailyLimit?: number;
  /** 检查间隔，默认 5 分钟 */
  checkMs?: number;
  /** 深夜静默（本地时间），默认 23 点到次日 9 点 */
  quietFrom?: number;
  quietTo?: number;
  /** 满足条件后仍要过的随机概率，默认 0.6 */
  chance?: number;
  /** Don't revive a conversation that has been over for hours. */
  maxContextAgeMs?: number;
  now?: () => number;
  random?: () => number;
}

export class ProactiveService {
  private readonly options: Required<Omit<ProactiveOptions, "now" | "random">>;
  private readonly deps: ProactiveDeps;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly lastAttemptAt = new Map<string, number>();
  private readonly daily = new Map<string, { day: string; count: number }>();
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private generation = 0;

  constructor(options: ProactiveOptions, deps: ProactiveDeps) {
    this.options = {
      enabled: options.enabled !== false,
      chats: options.chats,
      idleMs: options.idleMs ?? 45 * 60_000,
      cooldownMs: options.cooldownMs ?? 3 * 60 * 60_000,
      dailyLimit: options.dailyLimit ?? 2,
      checkMs: options.checkMs ?? 5 * 60_000,
      quietFrom: options.quietFrom ?? 23,
      quietTo: options.quietTo ?? 9,
      chance: options.chance ?? 0.6,
      maxContextAgeMs: options.maxContextAgeMs ?? 3 * 60 * 60_000,
    };
    this.deps = deps;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (!this.options.enabled || this.options.chats.length === 0 || this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.checkNow(); }, this.options.checkMs);
    this.timer.unref?.();
  }

  close(): void {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 扫描一遍允许发言的群；返回本轮真正发送过消息的 chatId（测试也直接调它）。 */
  async checkNow(): Promise<string[]> {
    if (!this.options.enabled || this.running || this.stopped) return [];
    const generation = this.generation;
    const now = this.now();
    if (this.isQuiet(now)) return [];
    this.running = true;
    const spoken: string[] = [];
    try {
      for (const chatId of this.options.chats) {
        if (this.stopped || generation !== this.generation) break;
        if (!this.shouldConsider(chatId, now)) continue;
        const snapshot = this.deps.recent(chatId);
        if (!snapshot || snapshot.messages.length === 0) continue;
        if (now - snapshot.lastAt < this.options.idleMs) continue;
        if (now - snapshot.lastAt > this.options.maxContextAgeMs || snapshot.messages.at(-1)?.self) continue;
        const fingerprint = JSON.stringify(snapshot);

        // 无论生成成功、失败还是 SKIP，都记一次尝试，避免每 5 分钟重试。
        this.lastAttemptAt.set(chatId, now);
        let text = "";
        try {
          text = (await this.deps.generate(snapshot)).trim();
        } catch {
          continue;
        }
        text = cleanProactiveText(text);
        if (!text || /^\[?\s*skip\b/i.test(text)) continue;
        if ([...text].length > 160) continue;
        if (snapshot.messages.some(message => message.self && message.text.trim() === text)) continue;
        // Generation takes time: don't interrupt fresh messages or answer an obsolete snapshot.
        const latest = this.deps.recent(chatId);
        const sendingAt = this.now();
        if (this.stopped || generation !== this.generation || !latest || JSON.stringify(latest) !== fingerprint || this.isQuiet(sendingAt)
          || sendingAt - latest.lastAt > this.options.maxContextAgeMs) continue;

        try {
          await this.deps.send(chatId, text);
        } catch {
          continue;
        }
        this.deps.recordSelf(chatId, text);
        const sentAt = this.now();
        this.lastAttemptAt.set(chatId, sentAt);
        this.bump(chatId, sentAt);
        spoken.push(chatId);
      }
    } finally {
      this.running = false;
    }
    return spoken;
  }

  /** 一份尝试时间同时约束失败与成功后的冷却。 */
  private shouldConsider(chatId: string, now: number): boolean {
    const lastAttempt = this.lastAttemptAt.get(chatId);
    if (lastAttempt !== undefined && now - lastAttempt < this.options.cooldownMs) return false;
    if (this.dailyCount(chatId, now) >= this.options.dailyLimit) return false;
    return this.random() < this.options.chance;
  }

  private isQuiet(now: number): boolean {
    const hour = new Date(now).getHours();
    return this.options.quietFrom <= this.options.quietTo
      ? hour >= this.options.quietFrom && hour < this.options.quietTo
      : hour >= this.options.quietFrom || hour < this.options.quietTo;
  }

  private dayKey(now: number): string {
    const date = new Date(now);
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }

  private dailyCount(chatId: string, now: number): number {
    const state = this.daily.get(chatId);
    return state && state.day === this.dayKey(now) ? state.count : 0;
  }

  private bump(chatId: string, now: number): void {
    const day = this.dayKey(now);
    const state = this.daily.get(chatId);
    if (!state || state.day !== day) this.daily.set(chatId, { day, count: 1 });
    else state.count += 1;
  }
}

/** 清掉模型可能带出来的前缀和引号；拒绝多段长文。 */
export function cleanProactiveText(text: string): string {
  return text
    .replace(/^大肥鱼\s*[：:]\s*/u, "")
    .replace(/^["“「]|["”」]$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
