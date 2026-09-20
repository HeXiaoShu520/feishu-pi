import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface InstanceLock {
  release(): Promise<void>;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 通过 data 目录下的 PID 文件阻止同一数据目录启动多个服务实例。
 * 进程异常退出后，下一次启动会清理已经不存在的 PID 对应的陈旧锁。
 */
export async function acquireInstanceLock(filePath: string): Promise<InstanceLock> {
  await mkdir(dirname(filePath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(filePath, "wx");
      await handle.writeFile(`${process.pid}\n`, "utf8");
      let released = false;
      return {
        async release(): Promise<void> {
          if (released) return;
          released = true;
          await handle.close().catch(() => undefined);
          await unlink(filePath).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const rawPid = await readFile(filePath, "utf8").catch(() => "");
      const pid = Number.parseInt(rawPid.trim(), 10);
      if (Number.isInteger(pid) && pid > 0 && processIsAlive(pid)) {
        throw new Error(`已有实例正在使用数据目录（PID ${pid}，锁文件：${filePath}）`);
      }
      await unlink(filePath).catch(() => undefined);
    }
  }

  throw new Error(`无法取得实例锁：${filePath}`);
}
