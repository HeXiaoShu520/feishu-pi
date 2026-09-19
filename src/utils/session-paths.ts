/**
 * 会话磁盘布局的公共定义：一次会话 = 磁盘上一个目录，会话期间产生的一切文件都在里面。
 *
 *   {sessionsRoot}/{sessionId}/          ← 会话目录（/new 后换新的 id 与新目录）
 *   ├── session.json                     ← 目录自述：会话 id / 所属会话 / 创建时间
 *   ├── *.jsonl                          ← Pi 会话历史
 *   ├── images/                          ← 用户发来的图片
 *   └── files/                           ← 用户发来的文件/语音/视频附件
 *
 * 会话目录之外只有"特殊"长期数据（data/ 下的记忆、用户、凭证、索引、共享缓存）。
 */

import { join } from "node:path";

/** 会话目录内的附件子目录（file/audio/video/media） */
export const ATTACHMENTS_SUBDIR = "files";
/** 会话目录内的图片子目录（用户发来的图片） */
export const IMAGES_SUBDIR = "images";
/** 会话目录自述文件名 */
export const SESSION_META_FILE = "session.json";

/** 会话目录内的附件目录：`{会话目录}/files/` */
export const attachmentsDirOfSession = (sessionDir: string): string => join(sessionDir, ATTACHMENTS_SUBDIR);
/** 会话目录内的图片目录：`{会话目录}/images/` */
export const imagesDirOfSession = (sessionDir: string): string => join(sessionDir, IMAGES_SUBDIR);

/** 文件/目录名消毒：把路径分隔符等文件系统保留字符替换为 _，防路径逃逸；空名兜底 unnamed。 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "unnamed";
}

/**
 * 生成会话 id（同时也是会话目录名）：`{YYYYMMDD}-{HHmmss}-{尾段}`。
 * 时间戳在前便于按时间排序与人工辨识；尾段默认 4 位随机（防同秒撞名），
 * 也可传其他尾段（如用户 openId 后 6 位，让目录名直接可见归属）。
 * 尾段须为不含分隔符的单段，长度由调用方保证。
 */
export function newSessionId(now: Date = new Date(), tail = Math.random().toString(36).slice(2, 6).padEnd(4, "0")): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${tail}`;
}
