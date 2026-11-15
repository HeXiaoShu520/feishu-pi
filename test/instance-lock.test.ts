import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock } from "../src/utils/instance-lock.ts";

describe("实例锁", () => {
  it("同一数据目录只允许一个实例，释放后可重新获取", async () => {
    const dir = await mkdtemp(join(tmpdir(), "instance-lock-"));
    const file = join(dir, ".instance.lock");
    try {
      const lock = await acquireInstanceLock(file);
      expect(await readFile(file, "utf8")).toContain(String(process.pid));
      await expect(acquireInstanceLock(file)).rejects.toThrow("已有实例");

      await lock.release();
      const again = await acquireInstanceLock(file);
      await again.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("心跳过期的陈旧锁会被接管，不再看 PID 是否被系统复用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "instance-lock-"));
    const file = join(dir, ".instance.lock");
    try {
      // 模拟一个已死实例留下的 PID；即使这个 PID 现在属于别的进程，也能接管。
      await writeFile(file, "18472\n", "utf8");
      const old = new Date(Date.now() - 60_000);
      await utimes(file, old, old);

      const lock = await acquireInstanceLock(file);
      expect(await readFile(file, "utf8")).toContain(String(process.pid));
      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
