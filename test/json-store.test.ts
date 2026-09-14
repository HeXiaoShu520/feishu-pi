import { describe, expect, it } from "vitest";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonMapStore } from "../src/utils/json-store.ts";

class TestStore extends JsonMapStore<{ v: number }> {
  async set(key: string, value: { v: number }): Promise<void> {
    await this.ensureLoaded();
    this.records.set(key, value);
    await this.persist();
  }

  async peek(key: string): Promise<{ v: number } | undefined> {
    await this.ensureLoaded();
    return this.records.get(key);
  }
}

describe("JsonMapStore.persist（写队列失败恢复）", () => {
  it("单次持久化失败只抛给当次调用方，队列恢复后后续写入正常落盘", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jsonstore-"));
    const file = join(dir, "store.json");
    writeFileSync(file, "{}\n", "utf8");
    // Windows 真实失败形态：持有文件句柄（默认不含 DELETE 共享）→ rename 目标文件必 EPERM，
    // 模拟杀软/索引服务占用下的事务文件替换失败
    const handle = openSync(file, "r+");

    const store = new TestStore(file);
    await expect(store.set("a", { v: 1 })).rejects.toThrow();

    // 关键回归：失败后写队列不再被 rejected promise 污染，解除占用后后续持久化恢复正常
    closeSync(handle);
    rmSync(file, { force: true });
    await store.set("c", { v: 3 });

    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, { v: number }>;
    expect(raw.a).toEqual({ v: 1 }); // 失败那次的内容仍在内存中，随下次写入一起落盘
    expect(raw.c).toEqual({ v: 3 });
    expect(await store.peek("c")).toEqual({ v: 3 });
  });
});
