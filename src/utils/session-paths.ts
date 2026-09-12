import { join } from "node:path";

/** 会话文件夹内附件的子目录名 */
export const ATTACHMENTS_SUBDIR = "files";

/**
 * 会话在磁盘上的专属文件夹：`{sessionRoot}/{消毒后的 conversationId}/`。
 *
 * 一个会话一个文件夹：Pi 会话历史（jsonl）与附件（files/ 子目录）都落在里面，
 * 会话身份与磁盘布局一一对应。conversationId 含冒号等文件系统非法字符（Windows 尤其），
 * 统一替换为 _；实际长度 ≤77，远低于 120 截断线，不会出现两个会话截断后撞名。
 */
export function conversationDir(sessionRoot: string, conversationId: string): string {
  return join(sessionRoot, sanitizeFileName(conversationId));
}

/** 会话文件夹内附件目录：`{sessionRoot}/{消毒后的 conversationId}/files/`。 */
export function attachmentsDir(sessionRoot: string, conversationId: string): string {
  return join(conversationDir(sessionRoot, conversationId), ATTACHMENTS_SUBDIR);
}

/** 文件/目录名消毒：把路径分隔符等文件系统保留字符替换为 _，防路径逃逸；空名兜底 unnamed。 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "unnamed";
}
