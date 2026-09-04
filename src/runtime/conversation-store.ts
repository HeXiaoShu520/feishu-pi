import { JsonMapStore } from "../utils/json-store.ts";

/** 一条会话映射记录 */
interface ConversationRecord {
  /** 该会话对应的 Pi Session JSONL 文件路径 */
  sessionFile: string;
  /** 最近一次写入时间（ISO 字符串） */
  updatedAt: string;
}

/** 使用 JSON 持久化飞书会话到 Pi Session 文件的映射。 */
export class ConversationStore extends JsonMapStore<ConversationRecord> {
  /** 返回会话对应的 Pi Session 文件。 */
  async get(conversationId: string): Promise<string | undefined> {
    await this.ensureLoaded();
    return this.records.get(conversationId)?.sessionFile;
  }

  /** 原子保存会话对应的 Pi Session 文件。 */
  async set(conversationId: string, sessionFile: string): Promise<void> {
    await this.ensureLoaded();
    this.records.set(conversationId, { sessionFile, updatedAt: new Date().toISOString() });
    await this.persist();
  }

  /** 删除会话映射。 */
  async delete(conversationId: string): Promise<void> {
    await this.remove(conversationId);
  }
}
