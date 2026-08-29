import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type MessageStatus = "processing" | "completed" | "failed";

interface MessageRecord {
  status: MessageStatus;
  updatedAt: number;
}

/** 使用 JSON 保存消息处理状态，避免重复投递重复执行 Agent。 */
export class MessageStore {
  private records = new Map<string, MessageRecord>();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  private readonly filePath: string;
  private readonly processingTtlMs: number;

  constructor(filePath: string, processingTtlMs = 10 * 60 * 1000) {
    this.filePath = filePath;
    this.processingTtlMs = processingTtlMs;
  }

  /** 原子认领一条消息；已完成或仍在处理的消息不会再次执行。 */
  async claim(messageId: string): Promise<boolean> {
    await this.load();
    const existing = this.records.get(messageId);
    if (existing && (existing.status === "completed" || (existing.status === "processing" && Date.now() - existing.updatedAt < this.processingTtlMs))) return false;
    this.records.set(messageId, { status: "processing", updatedAt: Date.now() });
    await this.persist();
    return true;
  }

  /** 标记消息处理完成。 */
  async complete(messageId: string): Promise<void> {
    await this.update(messageId, "completed");
  }

  /** 标记消息处理失败，避免重复投递立即再次执行。 */
  async fail(messageId: string): Promise<void> {
    await this.update(messageId, "failed");
  }

  private async update(messageId: string, status: MessageStatus): Promise<void> {
    await this.load();
    this.records.set(messageId, { status, updatedAt: Date.now() });
    await this.persist();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const records = JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, MessageRecord>;
      this.records = new Map(Object.entries(records));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = join(dirname(this.filePath), `.${Date.now()}-${process.pid}.tmp`);
      await writeFile(temporaryPath, `${JSON.stringify(Object.fromEntries(this.records), null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    });
    await this.writeQueue;
  }
}
