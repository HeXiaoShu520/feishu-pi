import { JsonMapStore } from "../utils/json-store.ts";

/** 消息处理状态：处理中 / 已完成 / 失败 */
type MessageStatus = "processing" | "completed" | "failed";

/** 一条消息的处理状态记录 */
interface MessageRecord {
  status: MessageStatus;
  /** 最近更新时间（epoch 毫秒），用于过期与卡住判断 */
  updatedAt: number;
}

/** processing 状态超过该时长视为卡住，允许重新认领 */
const PROCESSING_TTL_MS = 10 * 60 * 1000;
const PROCESSING_RENEW_INTERVAL_MS = 60 * 1000;

/** 使用 JSON 保存消息处理状态，避免重复投递重复执行 Agent。 */
export class MessageStore extends JsonMapStore<MessageRecord> {
  constructor(filePath: string) {
    super(filePath);
  }

  /** 原子认领一条消息；已完成或仍在处理的消息不会再次执行。 */
  async claim(messageId: string): Promise<boolean> {
    await this.ensureLoaded();
    const existing = this.records.get(messageId);
    if (existing && (existing.status === "completed" || (existing.status === "processing" && Date.now() - existing.updatedAt < PROCESSING_TTL_MS))) return false;
    // 检查与占位之间不能 await，否则并发投递都可能认领成功。
    this.records.set(messageId, { status: "processing", updatedAt: Date.now() });
    await this.persist();
    return true;
  }

  /**
   * 续租一条仍在处理中的消息。返回 false 表示该消息已经不再属于当前处理流程。
   * 续租由传输层持有，覆盖附件预处理和 Agent 长任务，避免固定 TTL 期间被重复认领。
   */
  async touch(messageId: string): Promise<boolean> {
    await this.ensureLoaded();
    const existing = this.records.get(messageId);
    if (!existing || existing.status !== "processing") return false;
    existing.updatedAt = Date.now();
    await this.persist();
    return true;
  }

  /** 启动处理租约心跳，返回停止函数。 */
  startLease(messageId: string, intervalMs = PROCESSING_RENEW_INTERVAL_MS): () => void {
    const timer = setInterval(() => {
      void this.touch(messageId).catch(() => undefined);
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** 标记消息处理完成。 */
  async complete(messageId: string): Promise<void> {
    await this.setStatus(messageId, "completed");
  }

  /** 标记处理失败，允许后续重复投递重试。 */
  async fail(messageId: string): Promise<void> {
    await this.setStatus(messageId, "failed");
  }

  /** 清理与正常写入共用内存和写队列，避免清理器直接改文件造成状态回退。 */
  async cleanup(cutoff: number, stuckBefore?: number): Promise<{ checked: number; cleaned: number }> {
    await this.ensureLoaded();
    const checked = this.records.size;
    let cleaned = 0;
    for (const [id, record] of this.records) {
      if (record.updatedAt < cutoff || (record.status === "processing" && stuckBefore !== undefined && record.updatedAt < stuckBefore)) {
        this.records.delete(id);
        cleaned++;
      }
    }
    if (cleaned) await this.persist();
    return { checked, cleaned };
  }

  /** 写入状态并落盘。 */
  private async setStatus(messageId: string, status: MessageStatus): Promise<void> {
    await this.ensureLoaded();
    this.records.set(messageId, { status, updatedAt: Date.now() });
    await this.persist();
  }
}
