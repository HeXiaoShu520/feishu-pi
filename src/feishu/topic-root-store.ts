import { JsonMapStore } from "../utils/json-store.ts";

/**
 * 话题根持久化：话题首条消息没有 threadId，用其 messageId 作为话题键。
 * 把 (chatId -> 待定话题根 messageId) 落盘，即使首条消息处理中被中断，
 * 后续消息（此时 threadId 已 = 根消息 ID）也能收敛到同一会话。
 */
export class TopicRootStore extends JsonMapStore<string> {
  /** 返回该群聊当前待定的话题根 messageId。 */
  async get(chatId: string): Promise<string | undefined> {
    await this.ensureLoaded();
    return this.records.get(chatId);
  }

  /** 登记话题根。 */
  async set(chatId: string, rootMessageId: string): Promise<void> {
    await this.ensureLoaded();
    this.records.set(chatId, rootMessageId);
    await this.persist();
  }

  /** 清除话题根（threadId 已确立，话题归属稳定）。 */
  async clear(chatId: string): Promise<void> {
    await this.remove(chatId);
  }
}
