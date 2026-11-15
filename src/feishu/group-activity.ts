/**
 * 群聊最近消息的轻量环形缓冲。
 *
 * 主动发言需要知道群里刚才在聊什么；这里只保留每个群最近的一小段文本和最后活动时间，
 * 不落盘、不做检索。私聊不记录。
 */

export interface GroupMessage {
  name: string;
  text: string;
  at: number;
  self?: boolean;
}

export interface GroupSnapshot {
  chatId: string;
  lastAt: number;
  messages: GroupMessage[];
}

const MAX_MESSAGES = 20;
const MAX_TEXT = 200;

export class GroupActivity {
  private readonly chats = new Map<string, { lastAt: number; messages: GroupMessage[] }>();

  /** 记录一条群消息；空文本和纯系统标记不占位置。 */
  observe(chatId: string, name: string, text: string, at = Date.now()): void {
    this.record(chatId, name, text, at, false);
  }

  private record(chatId: string, name: string, text: string, at: number, self: boolean): void {
    const clean = text.replace(/<at[^>]*>|<\/at>/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
    if (!clean) return;
    const state = this.chats.get(chatId) ?? { lastAt: 0, messages: [] };
    state.lastAt = at;
    this.chats.set(chatId, state);
    // Image messages still count as activity and invalidate an in-flight proactive reply.
    if (!self && (/^\[(?:图片|附件|表情包)/.test(clean) || /^<sticker\b/i.test(clean))) return;
    state.messages.push({ name: name || "群友", text: clean, at, ...(self ? { self: true } : {}) });
    if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES);
  }

  /** 机器人自己主动发了一句：推进最后活动时间，避免紧接着再次触发。 */
  observeSelf(chatId: string, text: string, at = Date.now()): void {
    this.record(chatId, "大肥鱼", text, at, true);
  }

  snapshot(chatId: string): GroupSnapshot | undefined {
    const state = this.chats.get(chatId);
    return state ? { chatId, lastAt: state.lastAt, messages: state.messages.map(message => ({ ...message })) } : undefined;
  }

  /** 已知的群列表；从未活跃的群不会出现在这里。 */
  list(): string[] {
    return [...this.chats.keys()];
  }
}
