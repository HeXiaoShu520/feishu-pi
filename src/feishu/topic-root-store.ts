import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * 话题根持久化：话题首条消息没有 threadId，用其 messageId 作为话题键。
 * 把 (chatId -> 待定话题根 messageId) 落盘，即使首条消息处理中被中断，
 * 后续消息（此时 threadId 已 = 根消息 ID）也能收敛到同一会话。
 */
export class TopicRootStore {
  private readonly roots = new Map<string, string>();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** 返回该群聊当前待定的话题根 messageId。 */
  async get(chatId: string): Promise<string | undefined> {
    await this.load();
    return this.roots.get(chatId);
  }

  /** 登记话题根。 */
  async set(chatId: string, rootMessageId: string): Promise<void> {
    await this.load();
    this.roots.set(chatId, rootMessageId);
    this.writeQueue = this.writeQueue.then(() => this.writeAtomically());
    await this.writeQueue;
  }

  /** 清除话题根（threadId 已确立，话题归属稳定）。 */
  async clear(chatId: string): Promise<void> {
    await this.load();
    if (!this.roots.has(chatId)) return;
    this.roots.delete(chatId);
    this.writeQueue = this.writeQueue.then(() => this.writeAtomically());
    await this.writeQueue;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const records = JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, string>;
      for (const [key, value] of Object.entries(records)) {
        if (typeof value === "string") this.roots.set(key, value);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async writeAtomically(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = join(dirname(this.filePath), `.topic-roots-${Date.now()}-${process.pid}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(Object.fromEntries(this.roots), null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}
