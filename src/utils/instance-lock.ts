import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface InstanceLock {
  release(): Promise<void>;
}

/** 运行中的实例定期重写锁文件，刷新 mtime。 */
const HEARTBEAT_MS = 15_000;
/** 超过这个时间没有心跳，视为崩溃残留；也避免 PID 被系统复用后误判。 */
const STALE_MS = 45_000;

/**
 * 通过 data 目录下的 PID 文件阻止同一数据目录启动多个服务实例。
 *
 * 不能只看 PID 是否存在：Windows 会复用 PID（曾把已死实例的 PID 分给 dwm，
 * 导致服务永远启动不了）。这里用「心跳 mtime」判断实例是否还活着：
 * 运行中的进程每 15 秒刷新一次锁文件，超过 45 秒没刷新就当陈旧锁清理。
 */
export async function acquireInstanceLock(filePath: string): Promise<InstanceLock> {
  await mkdir(dirname(filePath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(filePath, "wx");
      await handle.writeFile(`${process.pid}\n`, "utf8");

      const heartbeat = setInterval(() => {
        void handle.writeFile(`${process.pid}\n`, "utf8").catch(() => undefined);
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      let released = false;
      return {
        async release(): Promise<void> {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          await handle.close().catch(() => undefined);
          await unlink(filePath).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const info = await stat(filePath).catch(() => undefined);
      const stale = !info || Date.now() - info.mtimeMs > STALE_MS;
      if (!stale) {
        const rawPid = await readFile(filePath, "utf8").catch(() => "");
        throw new Error(`已有实例正在使用数据目录（PID ${rawPid.trim() || "未知"}，锁文件：${filePath}）。若确认没有实例在跑，删除该文件后重试。`);
      }
      await unlink(filePath).catch(() => undefined);
    }
  }

  throw new Error(`无法取得实例锁：${filePath}`);
}
