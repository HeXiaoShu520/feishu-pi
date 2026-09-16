/**
 * 数据清理工具
 * - 清理过期的会话文件（会话文件夹内与根目录下的 .jsonl）
 * - 清理会话文件夹里过期的附件（{会话}/files/），并收尾空目录
 * - 清理过期的图片缓存
 * - 清理过期的消息状态
 */

import { readdir, stat, unlink, readFile, writeFile, rmdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.ts";
import { ATTACHMENTS_SUBDIR } from "../utils/session-paths.ts";

export interface CleanupOptions {
  /** 会话数据根目录 */
  sessionDir: string;
  /** 保留天数，默认 7 天 */
  retentionDays?: number;
  /** 是否执行清理（false 只返回统计） */
}

export interface CleanupStats {
  sessionsChecked: number;
  sessionsDeleted: number;
  attachmentsChecked: number;
  attachmentsDeleted: number;
  imagesChecked: number;
  imagesDeleted: number;
  messagesChecked: number;
  messagesCleaned: number;
}

export class DataCleaner {
  private readonly sessionDir: string;
  /** 保留天数（默认 7 天） */
  private readonly retentionDays: number;
  private readonly retentionMs: number;

  constructor(options: CleanupOptions) {
    this.sessionDir = options.sessionDir;
    this.retentionDays = options.retentionDays ?? 7;
    this.retentionMs = this.retentionDays * 24 * 60 * 60 * 1000;
  }

  async cleanup(): Promise<CleanupStats> {
    const stats: CleanupStats = {
      sessionsChecked: 0,
      sessionsDeleted: 0,
      attachmentsChecked: 0,
      attachmentsDeleted: 0,
      imagesChecked: 0,
      imagesDeleted: 0,
      messagesChecked: 0,
      messagesCleaned: 0,
    };

    const now = Date.now();
    const cutoffTime = now - this.retentionMs;

    // 1. 清理过期的会话文件 (.jsonl)
    await this.cleanupSessions(cutoffTime, stats);

    // 2. 清理会话文件夹里过期的附件，收尾空目录
    await this.cleanupAttachments(cutoffTime, stats);

    // 3. 清理过期的图片缓存
    await this.cleanupImages(cutoffTime, stats);

    // 4. 清理过期的消息状态
    await this.cleanupMessages(cutoffTime, stats);

    return stats;
  }

  /** 文件过期则删除。过期计数在删除成功后写入，失败不虚报。 */
  private async unlinkIfExpired(filePath: string, cutoffTime: number, onDeleted: () => void): Promise<void> {
    try {
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs >= cutoffTime) return;
      await unlink(filePath);
      onDeleted();
    } catch (err) {
      logger.warn(`[DataCleaner] 无法处理文件 ${filePath}:`, err);
    }
  }

  /**
   * 清理过期的会话文件。会话历史的现行布局是 {会话文件夹}/*.jsonl；
   * 根目录下直接平铺的 .jsonl（旧布局遗留）同样纳入清理。
   */
  private async cleanupSessions(cutoffTime: number, stats: CleanupStats): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.sessionDir, { withFileTypes: true });
    } catch (err) {
      logger.error("[DataCleaner] 清理会话文件失败:", err);
      return;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        stats.sessionsChecked++;
        const filePath = join(this.sessionDir, entry.name);
        await this.unlinkIfExpired(filePath, cutoffTime, () => stats.sessionsDeleted++);
      } else if (entry.isDirectory() && entry.name !== "images") {
        // 会话文件夹：扫描其中的 .jsonl（文件夹本身可能还有 attachments/files 等）
        const dirPath = join(this.sessionDir, entry.name);
        const files = await readdir(dirPath).catch(() => [] as string[]);
        for (const file of files.filter((f) => f.endsWith(".jsonl"))) {
          stats.sessionsChecked++;
          await this.unlinkIfExpired(join(dirPath, file), cutoffTime, () => stats.sessionsDeleted++);
        }
      }
    }
  }

  /**
   * 清理会话文件夹里过期的附件（{会话}/files/ 下的文件，按同一保留期）。
   * files/ 清空后顺手移除；会话文件夹因此变成空壳时也一并移除（非空目录 rmdir 会失败，静默忽略即可）。
   */
  private async cleanupAttachments(cutoffTime: number, stats: CleanupStats): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.sessionDir, { withFileTypes: true });
    } catch (err) {
      logger.error("[DataCleaner] 清理附件失败:", err);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "images") continue;
      const convDir = join(this.sessionDir, entry.name);
      const filesDir = join(convDir, ATTACHMENTS_SUBDIR);
      const files = await readdir(filesDir).catch(() => [] as string[]);

      for (const file of files) {
        stats.attachmentsChecked++;
        await this.unlinkIfExpired(join(filesDir, file), cutoffTime, () => stats.attachmentsDeleted++);
      }

      // 空目录收尾：rmdir 只能删空目录，非空（还有 jsonl 或未过期附件）时静默失败
      await rmdir(filesDir).catch(() => undefined);
      await rmdir(convDir).catch(() => undefined);
    }
  }

  /** 清理过期的图片缓存 */
  private async cleanupImages(cutoffTime: number, stats: CleanupStats): Promise<void> {
    const imagesDir = join(this.sessionDir, "images");

    try {
      const files = await readdir(imagesDir);

      for (const file of files) {
        stats.imagesChecked++;
        const filePath = join(imagesDir, file);

        try {
          const fileStat = await stat(filePath);
          if (fileStat.mtimeMs < cutoffTime) {
            await unlink(filePath);
            stats.imagesDeleted++;
          }
        } catch (err) {
          logger.warn(`[DataCleaner] 无法处理图片 ${file}:`, err);
        }
      }
    } catch (err) {
      // 图片目录可能不存在，忽略
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.error("[DataCleaner] 清理图片缓存失败:", err);
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
    const messagesFile = join(this.sessionDir, "messages.json");

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
