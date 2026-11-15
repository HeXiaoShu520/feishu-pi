/** Trusted identity facts, shared by production and evaluation. Rules stay in SYSTEM.md. */
export function conversationIdentity(isOwner: boolean, mode?: string): string {
  return `当前交谈身份资料：${JSON.stringify({
    scene: mode === "p2p" ? "私聊" : mode === "topic" ? "群聊话题" : "群聊",
    ownerAddress: "你日常称本机主人为哥哥",
    currentSpeaker: isOwner ? "本机主人，即哥哥" : "另一位普通朋友，并非本机主人",
  })}`;
}

/** Short-lived, factual continuity. No invented mood, offline life, or affection score. */
export class ConversationPresence {
  private readonly chats = new Map<string, { lastAt: number; replies: string[] }>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  recall(id: string): string {
    const now = this.now();
    if (this.chats.has(id) && now - this.chats.get(id)!.lastAt > 24 * 60 * 60_000) this.chats.delete(id);
    const state = this.chats.get(id);
    return `当前聊天时间资料：${JSON.stringify({
      now: new Date(now).toISOString(),
      localTime: new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "full", timeStyle: "long", hourCycle: "h23",
      }).format(new Date(now)),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(state ? { secondsSinceLastReply: Math.max(0, Math.round((now - state.lastAt) / 1000)),
        recentDeliveredReplies: state.replies } : {}),
    })}`;
  }

  delivered(id: string, text: string, sticker: boolean): void {
    const now = this.now();
    for (const [key, value] of this.chats) if (now - value.lastAt > 24 * 60 * 60_000) this.chats.delete(key);
    const state = this.chats.get(id) ?? { lastAt: now, replies: [] };
    const reply = text.trim().slice(0, 180) || (sticker ? "[已发送一张表情图片]" : "");
    if (!reply) return;
    state.lastAt = now;
    state.replies = [...state.replies, reply].slice(-3);
    this.chats.delete(id);
    this.chats.set(id, state);
    // Only an in-memory hint, bounded independently of session persistence.
    if (this.chats.size > 1000) this.chats.delete(this.chats.keys().next().value!);
  }

  clear(id: string): void { this.chats.delete(id); }
}
