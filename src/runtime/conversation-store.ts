import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface ConversationRecord {
  sessionFile: string;
  updatedAt: string;
}

/** 使用 JSON 持久化飞书会话到 Pi Session 文件的映射。 */
export class ConversationStore {
  private readonly records = new Map<string, ConversationRecord>();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** 返回会话对应的 Pi Session 文件。 */
  async get(conversationId: string): Promise<string | undefined> {
    await this.load();
    return this.records.get(conversationId)?.sessionFile;
  }

  /** 原子保存会话对应的 Pi Session 文件。 */
  async set(conversationId: string, sessionFile: string): Promise<void> {
    await this.load();
    this.records.set(conversationId, { sessionFile, updatedAt: new Date().toISOString() });
    this.writeQueue = this.writeQueue.then(() => this.writeAtomically());
    await this.writeQueue;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const records = JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, ConversationRecord>;
      for (const [key, value] of Object.entries(records)) {
        if (value?.sessionFile) this.records.set(key, value);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async writeAtomically(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = join(dirname(this.filePath), `.${Date.now()}-${process.pid}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(Object.fromEntries(this.records), null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}
