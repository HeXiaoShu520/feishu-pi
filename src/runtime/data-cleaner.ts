/**
 * 数据清理：**以会话目录为最小单位**——一次会话一个目录，整个目录过期（默认 7 天）就整体删除。
 *
 * 为什么不按文件删：会话目录是不可分割的整体（历史 jsonl、图片、附件、OCR 过程文件都在里面），
 * 按文件删只会留下"历史没了、附件还在"的半截会话。过期判定用目录树内最新的 mtime，
 * 也就是这个会话最后一次活动的时间；只要还在用，目录就不会被判过期。
 *
 * 会话目录之外的长期数据不在这里清理：记忆、用户资料、凭证、会话索引等属于"特殊"数据，
 * 有各自的过期策略（如消息去重表按 updatedAt 随同一保留期清理）。
 */

import { readdir, readFile, stat, unlink, rm, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.ts";

export interface CleanupOptions {
  /** 会话目录根（一次会话一个目录） */
  sessionsRoot: string;
  /** 保留天数，默认 7 天 */
  retentionDays?: number;
  /** 消息去重表路径（可选；按 updatedAt 用同一保留期清理） */
  messagesFile?: string;
}

export interface CleanupStats {
  /** 检查过的会话目录（含根目录下的散落文件）数 */
  sessionsChecked: number;
  /** 整目录删除的会话数 */
  sessionsDeleted: number;
  messagesChecked: number;
  messagesCleaned: number;
}

export class DataCleaner {
  private readonly sessionsRoot: string;
  private readonly messagesFile?: string;
  private readonly retentionMs: number;

  constructor(options: CleanupOptions) {
    this.sessionsRoot = options.sessionsRoot;
    this.messagesFile = options.messagesFile;
    this.retentionMs = (options.retentionDays ?? 7) * 24 * 60 * 60 * 1000;
  }

  async cleanup(): Promise<CleanupStats> {
    const stats: CleanupStats = { sessionsChecked: 0, sessionsDeleted: 0, messagesChecked: 0, messagesCleaned: 0 };
    const cutoffTime = Date.now() - this.retentionMs;

    await this.cleanupSessions(cutoffTime, stats);
    if (this.messagesFile) await this.cleanupMessages(cutoffTime, stats);
    return stats;
  }

  /**
   * 清理过期的会话目录。目录树内最新的 mtime 即该会话的最后活跃时间，
   * 早于保留期就直接整目录删掉；根目录下散落的文件（旧布局遗留）按 mtime 一并清理。
   */
  private async cleanupSessions(cutoffTime: number, stats: CleanupStats): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.sessionsRoot, { withFileTypes: true });
    } catch (err) {
      // 目录不存在 = 还没有会话数据，无东西可清
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") logger.error("[DataCleaner] 读取会话目录失败:", err);
      return;
    }

    for (const entry of entries) {
      const fullPath = join(this.sessionsRoot, entry.name);
      stats.sessionsChecked++;

      const lastActiveAt = entry.isDirectory() ? await lastActiveAtOf(fullPath) : await mtimeOf(fullPath);
      if (lastActiveAt === undefined || lastActiveAt >= cutoffTime) continue;

      try {
        if (entry.isDirectory()) {
          await rm(fullPath, { recursive: true, force: true });
          stats.sessionsDeleted++;
          logger.info(`[DataCleaner] 已清理过期会话目录: ${entry.name}`);
        } else {
          await unlink(fullPath);
          stats.sessionsDeleted++;
        }
      } catch (err) {
        logger.warn(`[DataCleaner] 清理失败 ${fullPath}:`, err);
      }
    }
  }

  /**
   * cleanupMessages 与 cleanupStuckMessages 共用此框架，仅过滤谓词不同。
   * 返回被清理的条数。
   */
  private async filterMessagesFile(
    predicate: (data: { status: string; updatedAt: number }) => boolean,
    label: string,
  ): Promise<number> {
    const messagesFile = this.messagesFile;
    if (!messagesFile) return 0;

    try {
      const content = await readFile(messagesFile, "utf-8");
      const messages = JSON.parse(content) as Record<string, { status: string; updatedAt: number }>;

      const newMessages: typeof messages = {};
      let cleaned = 0;
      for (const [messageId, data] of Object.entries(messages)) {
        if (predicate(data)) {
          cleaned++;
        } else {
          newMessages[messageId] = data;
        }
      }

      if (cleaned > 0) {
        await writeFile(messagesFile, JSON.stringify(newMessages, null, 2), "utf-8");
      }
      return cleaned;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.error(`[DataCleaner] ${label}失败:`, err);
      }
      return 0;
    }
  }

  /** 清理过期的消息状态 */
  private async cleanupMessages(cutoffTime: number, stats: CleanupStats): Promise<void> {
    // 谓词：更新时间早于截止时间即过期
    stats.messagesCleaned = await this.filterMessagesFile((data) => {
      stats.messagesChecked++;
      return data.updatedAt < cutoffTime;
    }, "清理消息状态");
  }

  /** 清理卡住的消息（processing 状态超过 timeoutMs，默认 1 小时） */
  async cleanupStuckMessages(timeoutMs = 60 * 60 * 1000): Promise<number> {
    const now = Date.now();
    // 谓词：卡在 processing 状态超过 timeoutMs
    return this.filterMessagesFile((data) => {
      const stuck = data.status === "processing" && now - data.updatedAt > timeoutMs;
      if (stuck) logger.warn(`[DataCleaner] 清理卡住的消息`);
      return stuck;
    }, "清理卡住消息");
  }
}

/** 单个文件/目录自身的 mtime；读不到返回 undefined。 */
async function mtimeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * 目录树的最后活跃时间 = 树内最新的 mtime（含目录自身）。
 * 子项读不到（权限/并发删除）按"无该子项"处理，不影响其余部分的判定。
 */
async function lastActiveAtOf(dir: string): Promise<number | undefined> {
  const own = await mtimeOf(dir);
  if (own === undefined) return undefined;

  let latest = own;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const sub = entry.isDirectory() ? await lastActiveAtOf(full) : await mtimeOf(full);
    if (sub !== undefined && sub > latest) latest = sub;
  }
  return latest;
}
