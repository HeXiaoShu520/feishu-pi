import { JsonMapStore } from "../utils/json-store.ts";

/** 消息处理状态：处理中 / 已完成 / 失败 */
type MessageStatus = "processing" | "completed" | "failed";

/** 一条消息的处理状态记录 */
interface MessageRecord {
  status: MessageStatus;
  /** 最近更新时间（epoch 毫秒），用于过期与卡住判断 */
  updatedAt: number;
}

/** 使用 JSON 保存消息处理状态，避免重复投递重复执行 Agent。 */
export class MessageStore extends JsonMapStore<MessageRecord> {
  /** processing 状态超过该时长视为卡住，允许重新认领 */
  private readonly processingTtlMs: number;

  constructor(filePath: string, processingTtlMs = 10 * 60 * 1000) {
    super(filePath);
    this.processingTtlMs = processingTtlMs;
  }

  /** 原子认领一条消息；已完成或仍在处理的消息不会再次执行。 */
  async claim(messageId: string): Promise<boolean> {
    await this.ensureLoaded();
    const existing = this.records.get(messageId);
    if (existing && (existing.status === "completed" || (existing.status === "processing" && Date.now() - existing.updatedAt < this.processingTtlMs))) return false;
    await this.setStatus(messageId, "processing");
    return true;
  }

  /** 标记消息处理完成。 */
  async complete(messageId: string): Promise<void> {
    await this.setStatus(messageId, "completed");
  }

  /** 标记消息处理失败，避免重复投递立即再次执行。 */
  async fail(messageId: string): Promise<void> {
    await this.setStatus(messageId, "failed");
  }

  /** 写入状态并落盘。 */
  private async setStatus(messageId: string, status: MessageStatus): Promise<void> {
    await this.ensureLoaded();
    this.records.set(messageId, { status, updatedAt: Date.now() });
    await this.persist();
  }
}
