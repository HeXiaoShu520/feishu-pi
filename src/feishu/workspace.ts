/**
 * 会话工作区：work_space/ 下每个会话一个文件夹（session-<时间>-<会话id后6位>），
 * 会话期间产生的一切文件（下载的附件、图片等）都归拢在里面，方便按会话查找。
 *
 * 命名确定性：进程重启后对同一会话按"文件夹名以 -<会话id消毒后6位> 结尾"找回旧目录，
 * 找不到才用当前时间新建——因此同一会话跨重启仍归拢到同一文件夹。
 */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeFileName } from "../utils/session-paths.ts";

/** 工作区文件夹名的消毒：去掉路径非法字符 */
const tail6 = (conversationId: string): string =>
  sanitizeFileName(conversationId).replace(/\s/g, "").slice(-6);

export class WorkspaceManager {
  private readonly root: string;
  /** 会话 id → 工作区绝对路径（进程内缓存；跨重启按后缀找回） */
  private readonly dirs = new Map<string, string>();

  constructor(root: string) {
    this.root = root;
  }

  /** 返回该会话的工作区绝对路径（不存在则创建；同会话恒定）。 */
  async dirFor(conversationId: string): Promise<string> {
    const cached = this.dirs.get(conversationId);
    if (cached) return cached;

    const tail = tail6(conversationId);
    let name: string | undefined;
    try {
      const names = await readdir(this.root);
      name = names.find((n) => n.endsWith(`-${tail}`));
    } catch {
      // 根目录尚不存在：走新建
    }
    if (!name) {
      const t = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      name = `session-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}-${tail}`;
    }
    const dir = join(this.root, name);
    await mkdir(dir, { recursive: true });
    this.dirs.set(conversationId, dir);
    return dir;
  }
}
