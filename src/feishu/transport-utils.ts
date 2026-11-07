/**
 * 飞书传输层的独立工具函数：附件下载、消息清洗、会话 ID 构建。
 * 从 lark-transport.ts 拆分出来，降低单文件复杂度。
 */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.ts";
import { sanitizeFileName } from "../utils/session-paths.ts";

/**
 * 下载文件类附件（file/audio/video/media）到本会话目录的 files/ 子目录
 * （`{会话目录}/files/`），返回要追加到消息文本的附件说明（无附件时为空串）。
 *
 * 文件名带时间戳 + 随机前缀，同一会话先后传同名文件不互相覆盖；单个下载失败只记 warn，不影响其余附件。
 */
export async function downloadFileAttachments(
  targetDir: string,
  resources: ReadonlyArray<{ type: string; fileKey: string; fileName?: string }>,
  download: (fileKey: string, type: string) => Promise<Buffer>,
  limits: { maxResourceBytes: number; maxTotalBytes: number } = {
    maxResourceBytes: 20 * 1024 * 1024,
    maxTotalBytes: 40 * 1024 * 1024,
  },
  transcribe?: (data: Buffer, fileName: string) => Promise<string | undefined>,
): Promise<string> {
  const fileResources = resources.filter((r) => ["file", "audio", "video", "media"].includes(r.type) && r.fileKey);
  if (fileResources.length === 0) return "";

  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(targetDir, { recursive: true });

  let attachmentNote = "";
  let totalBytes = 0;
  for (const resource of fileResources.slice(0, 5)) {
    try {
      const buffer = await download(resource.fileKey, resource.type);
      if (buffer.length > limits.maxResourceBytes) {
        throw new Error(`附件超过单文件大小限制（${limits.maxResourceBytes} 字节）`);
      }
      if (totalBytes + buffer.length > limits.maxTotalBytes) {
        throw new Error(`附件超过单条消息总大小限制（${limits.maxTotalBytes} 字节）`);
      }
      const fileName = sanitizeFileName(resource.fileName || (resource.type === "audio" ? `${resource.fileKey}.ogg` : resource.fileKey));
      const filePath = join(targetDir, `${Date.now()}-${randomUUID()}-${fileName}`);
      await writeFile(filePath, buffer);
      totalBytes += buffer.length;
      attachmentNote += `\n[${resource.type === "audio" ? "语音" : resource.type === "video" ? "视频" : "附件"}] ${fileName} 已保存到: ${filePath}`;
      if (resource.type === "audio" && transcribe) {
        try {
          const words = await transcribe(buffer, fileName);
          if (words) attachmentNote += `\n[语音转写] ${words}`;
        } catch (error) {
          logger.warn(`[LarkTransport] 语音转写失败 ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      logger.warn(`[LarkTransport] 下载附件失败 ${resource.fileKey}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return attachmentNote;
}

/** 过滤消息中的 @ 机器人标记（normalize 已按占位符替换，这里对残留标记兜底清洗）。 */
export function stripBotMentions(text: string, botOpenId: string | undefined): string {
  if (!botOpenId) return text.trim();
  return text
    .replace(new RegExp(`<at\\s+user_id="${botOpenId}"[^>]*>.*?</at>`, "gi"), "")
    .replace(new RegExp(`@${botOpenId}\\s*`, "gi"), "")
    .trim();
}

/** 飞书根消息独立成话题；回复使用 threadId，不猜测群内"待定根"。 */
export function buildConversationId(chatId: string, chatMode: "p2p" | "group" | "topic", threadId: string | undefined, messageId: string): string {
  return chatMode === "topic" ? `topic:${chatId}:${threadId ?? messageId}` : `${chatMode}-${chatId}`;
}

/** A guest never inherits the administrator's or another member's agent history. */
export function scopeGuestConversation(conversationId: string, chatMode: "p2p" | "group" | "topic", senderId: string, ownerId?: string): string {
  return chatMode !== "p2p" && senderId !== ownerId ? `${conversationId}:guest:${senderId}` : conversationId;
}
