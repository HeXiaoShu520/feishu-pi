/**
 * 数据清理工具
 * - 清理过期的会话文件
 * - 清理过期的图片缓存
 * - 清理过期的消息状态
 */

import { readdir, stat, unlink, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CleanupOptions {
  /** 会话目录 */
  sessionDir: string;
  /** 保留天数，默认 7 天 */
  retentionDays?: number;
  /** 是否执行清理（false 只返回统计） */
  dryRun?: boolean;
}

export interface CleanupStats {
  sessionsChecked: number;
  sessionsDeleted: number;
  imagesChecked: number;
  imagesDeleted: number;
  messagesChecked: number;
  messagesCleaned: number;
}

export class DataCleaner {
  private readonly sessionDir: string;
  private readonly retentionMs: number;
  private readonly dryRun: boolean;

  constructor(options: CleanupOptions) {
    this.sessionDir = options.sessionDir;
    this.retentionDays = options.retentionDays ?? 7;
    this.retentionMs = this.retentionDays * 24 * 60 * 60 * 1000;
    this.dryRun = options.dryRun ?? false;
  }

  private retentionDays: number;

  async cleanup(): Promise<CleanupStats> {
    const stats: CleanupStats = {
      sessionsChecked: 0,
      sessionsDeleted: 0,
      imagesChecked: 0,
      imagesDeleted: 0,
      messagesChecked: 0,
      messagesCleaned: 0,
    };

    const now = Date.now();
    const cutoffTime = now - this.retentionMs;

    // 1. 清理过期的会话文件 (.jsonl)
    await this.cleanupSessions(cutoffTime, stats);

    // 2. 清理过期的图片缓存
    await this.cleanupImages(cutoffTime, stats);

    // 3. 清理过期的消息状态
    await this.cleanupMessages(cutoffTime, stats);

    return stats;
  }

  /** 清理过期的会话文件 */
  private async cleanupSessions(cutoffTime: number, stats: CleanupStats): Promise<void> {
    try {
      const files = await readdir(this.sessionDir);
      const sessionFiles = files.filter((f) => f.endsWith(".jsonl"));

      for (const file of sessionFiles) {
        stats.sessionsChecked++;
        const filePath = join(this.sessionDir, file);

        try {
          const fileStat = await stat(filePath);
          if (fileStat.mtimeMs < cutoffTime) {
            if (!this.dryRun) {
              await unlink(filePath);
            }
            stats.sessionsDeleted++;
          }
        } catch (err) {
          console.warn(`[DataCleaner] 无法处理会话文件 ${file}:`, err);
        }
      }
    } catch (err) {
      console.error("[DataCleaner] 清理会话文件失败:", err);
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
            if (!this.dryRun) {
              await unlink(filePath);
            }
            stats.imagesDeleted++;
          }
        } catch (err) {
          console.warn(`[DataCleaner] 无法处理图片 ${file}:`, err);
        }
      }
    } catch (err) {
      // 图片目录可能不存在，忽略
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[DataCleaner] 清理图片缓存失败:", err);
      }
    }
  }

  /** 清理过期的消息状态 */
  private async cleanupMessages(cutoffTime: number, stats: CleanupStats): Promise<void> {
    const messagesFile = join(this.sessionDir, "messages.json");

    try {
      const content = await readFile(messagesFile, "utf-8");
      const messages = JSON.parse(content) as Record<
        string,
        { status: string; updatedAt: number }
      >;

      const newMessages: typeof messages = {};
      let cleaned = 0;

      for (const [messageId, data] of Object.entries(messages)) {
        stats.messagesChecked++;
        if (data.updatedAt < cutoffTime) {
          cleaned++;
        } else {
          newMessages[messageId] = data;
        }
      }

      if (cleaned > 0 && !this.dryRun) {
        await writeFile(messagesFile, JSON.stringify(newMessages, null, 2), "utf-8");
      }

      stats.messagesCleaned = cleaned;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[DataCleaner] 清理消息状态失败:", err);
      }
    }
  }

  /** 清理卡住的消息（processing 状态超过 1 小时） */
  async cleanupStuckMessages(timeoutMs = 60 * 60 * 1000): Promise<number> {
    const messagesFile = join(this.sessionDir, "messages.json");
    const now = Date.now();

    try {
      const content = await readFile(messagesFile, "utf-8");
      const messages = JSON.parse(content) as Record<
        string,
        { status: string; updatedAt: number }
      >;

      const newMessages: typeof messages = {};
      let cleaned = 0;

      for (const [messageId, data] of Object.entries(messages)) {
        // 清理卡在 processing 状态超过 timeoutMs 的消息
        if (data.status === "processing" && now - data.updatedAt > timeoutMs) {
          console.warn(`[DataCleaner] 清理卡住的消息: ${messageId}`);
          cleaned++;
        } else {
          newMessages[messageId] = data;
        }
      }

      if (cleaned > 0 && !this.dryRun) {
        await writeFile(messagesFile, JSON.stringify(newMessages, null, 2), "utf-8");
      }

      return cleaned;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[DataCleaner] 清理卡住消息失败:", err);
      }
      return 0;
    }
  }
}
