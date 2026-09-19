/**
 * 会话注册表：飞书 conversationId → 当前会话（会话 id + 会话目录 + Pi 会话文件）。
 *
 * 一个 conversationId（私聊 / 群聊 / 话题）在任一时刻只对应一个会话；`/new` 换新会话
 * （新 id + 新目录），旧目录留在磁盘上等过期清理，因此历史目录还能被人翻出来。
 *
 * 这里是"会话目录在哪"的唯一事实来源：传输层下载图片/附件、运行时落 Pi 会话文件，
 * 都从同一个记录取目录，二者永远落在同一个会话目录里。
 */
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonMapStore } from "../utils/json-store.ts";
import { newSessionId, SESSION_META_FILE } from "../utils/session-paths.ts";
import { logger } from "../utils/logger.ts";

/** 目录是否存在（清理器可能已把整个会话目录删掉） */
async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** 一条会话记录 */
export interface SessionRecord {
  /** 会话 id（= 会话目录名），/new 后换新 */
  sessionId: string;
  /** 会话目录绝对路径 */
  dir: string;
  /** Pi 会话文件（jsonl）绝对路径；Pi 首次落盘前为空 */
  sessionFile?: string;
  /** 创建时间（epoch 毫秒） */
  createdAt: number;
  /** 最近一次更新时间（epoch 毫秒） */
  updatedAt: number;
}

export class SessionStore extends JsonMapStore<SessionRecord> {
  /** 会话目录根（work_space/） */
  private readonly root: string;
  /** 同一 conversationId 的并发首次创建合并，避免同时开两个会话 */
  private readonly pending = new Map<string, Promise<SessionRecord>>();

  constructor(filePath: string, root: string) {
    super(filePath);
    this.root = root;
  }

  /** 该会话当前的记录；不存在（或目录已被清理掉）时新建一个会话。 */
  async getOrCreate(conversationId: string, callerOpenId?: string): Promise<SessionRecord> {
    const inflight = this.pending.get(conversationId);
    if (inflight) return inflight;
    const task = this.getOrCreateInner(conversationId, callerOpenId).finally(() => {
      if (this.pending.get(conversationId) === task) this.pending.delete(conversationId);
    });
    this.pending.set(conversationId, task);
    return task;
  }

  /** 会话目录绝对路径（需要时先建目录）。传输层下载图片/附件前调用。 */
  async dirFor(conversationId: string, callerOpenId?: string): Promise<string> {
    return (await this.getOrCreate(conversationId, callerOpenId)).dir;
  }

  /**
   * 记录 Pi 落盘的会话文件。expectedSessionId 用于防止"上一代会话"的孤儿任务
   * 在 /new 之后把旧会话文件写回新记录——代次不符直接忽略。
   */
  async setSessionFile(conversationId: string, sessionFile: string, expectedSessionId: string): Promise<void> {
    await this.ensureLoaded();
    const record = this.records.get(conversationId);
    if (!record || record.sessionId !== expectedSessionId) return;
    if (record.sessionFile === sessionFile) return;
    this.records.set(conversationId, { ...record, sessionFile, updatedAt: Date.now() });
    await this.persist();
  }

  /** `/new`：为该会话开一代新会话（新 id + 新目录 + 空历史），旧目录留在磁盘等过期清理。 */
  async rotate(conversationId: string, callerOpenId?: string): Promise<SessionRecord> {
    const previous = this.pending.get(conversationId);
    const task = (async () => {
      await previous?.catch(() => undefined);
      await this.ensureLoaded();
      const record = await this.createRecord(conversationId, callerOpenId);
      logger.info(`[Session] 会话已换代: ${conversationId} → ${record.sessionId}`);
      return record;
    })().finally(() => {
      if (this.pending.get(conversationId) === task) this.pending.delete(conversationId);
    });
    this.pending.set(conversationId, task);
    return task;
  }

  private async getOrCreateInner(conversationId: string, callerOpenId?: string): Promise<SessionRecord> {
    await this.ensureLoaded();
    const existing = this.records.get(conversationId);
    // 目录可能已被保留期清理删掉：历史不在了就当新会话重建（每次取会话只多一次 stat）
    if (existing && (await dirExists(existing.dir))) return existing;
    if (existing) logger.warn(`[Session] 会话目录已不存在，重建会话: ${conversationId}（${existing.sessionId}）`);
    return this.createRecord(conversationId, callerOpenId);
  }

  /** 新建一代会话：分配不重名的会话 id、建目录、写自述文件、登记路由。 */
  private async createRecord(conversationId: string, callerOpenId?: string): Promise<SessionRecord> {
    // UUID 直接分配唯一目录，mkdir 非递归保证不覆盖已有目录。
    await mkdir(this.root, { recursive: true });
    const owner = callerOpenId?.slice(-6).replace(/[^A-Za-z0-9]/g, "");
    const sessionId = newSessionId(undefined, `${owner ? `${owner}-` : ""}${randomUUID().slice(0, 6)}`);
    const dir = join(this.root, sessionId);
    await mkdir(dir);
    const now = Date.now();
    const record: SessionRecord = { sessionId, dir, createdAt: now, updatedAt: now };
    await this.writeMeta(dir, conversationId, sessionId, now);
    this.records.set(conversationId, record);
    await this.persist();
    return record;
  }

  /** 目录自述文件：让人一眼看出这是哪次会话的目录（也会随目录一起被清理）。 */
  private async writeMeta(dir: string, conversationId: string, sessionId: string, createdAt: number): Promise<void> {
    await writeFile(
      join(dir, SESSION_META_FILE),
      `${JSON.stringify({ sessionId, conversationId, createdAt: new Date(createdAt).toISOString() }, null, 2)}\n`,
      "utf8",
    );
  }
}
