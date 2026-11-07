/**
 * 最近发送记录：同一张表情短时间别反复刷屏。
 * 进程内状态，重启清零；只降权不排除，保证搜索结果凑得满 limit。
 * 记录全局不分 chat：私聊和群里共享一份"最近"——单用户个人 Agent 场景
 * 可接受，若未来多租户再按 chatId 分桶。
 */

const recent: string[] = [];
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SentSticker { id: string; line: string; at: number }
export class StickerHistory {
  private queues = new Map<string, Promise<void>>();
  private readonly root: string;
  constructor(root: string) { this.root = root; }
  private file(chatId: string): string {
    if (!chatId.trim()) throw new Error("缺少聊天 ID");
    return join(this.root, `${createHash("sha256").update(chatId).digest("hex")}.json`);
  }
  private async read(chatId: string): Promise<SentSticker[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file(chatId), "utf8"));
      if (!Array.isArray(value) || value.some(v => !v || typeof v.id !== "string" || typeof v.line !== "string" || !Number.isFinite(v.at))) throw new Error("表情记录损坏");
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  private enqueue<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(chatId) ?? Promise.resolve()).catch(() => {}).then(work);
    const done = result.then(() => {}, () => {}); this.queues.set(chatId, done);
    void done.then(() => { if (this.queues.get(chatId) === done) this.queues.delete(chatId); });
    return result;
  }
  async list(chatId: string): Promise<SentSticker[]> { return this.enqueue(chatId, () => this.read(chatId)); }
  async record(chatId: string, id: string, line: string): Promise<void> {
    return this.enqueue(chatId, async () => {
      const items = await this.read(chatId); items.unshift({ id, line: line.slice(0, 200), at: Date.now() });
      await mkdir(this.root, { recursive: true });
      const file = this.file(chatId), temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(items.slice(0, 30)), "utf8"); await rename(temp, file);
    });
  }
}

/** 记住的数量：一次会话自然发送量在个位数，8 条足够覆盖"最近"语义 */
const MAX = 8;

export function recordSent(id: string): void {
  const index = recent.indexOf(id);
  if (index >= 0) recent.splice(index, 1);
  recent.unshift(id);
  if (recent.length > MAX) recent.length = MAX;
}

export function recentSent(): readonly string[] {
  return recent;
}

/** 越新压得越狠：刚发过 ×0.3，往回线性回升，出列后恢复 ×1 */
export function sentPenalty(id: string, order: readonly string[] = recent): number {
  const index = order.indexOf(id);
  if (index < 0) return 1;
  return Math.min(1, 0.3 + 0.05 * index);
}
