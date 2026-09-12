import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataCleaner } from "../src/runtime/data-cleaner.ts";

/** 把文件 mtime 拨到 10 天前（保留期默认 7 天，即视为过期） */
async function age(path: string): Promise<void> {
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await utimes(path, old, old);
}

describe("DataCleaner 统一会话文件夹布局", () => {
  it("清理会话文件夹里过期的 jsonl 与过期附件，保留未过期内容并收尾空目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "clean-"));

    // 会话 1：旧 jsonl 与旧附件过期应删；新 jsonl 与新附件保留；目录不删
    const conv1 = join(root, "ou_x-chat_oc_y");
    await mkdir(join(conv1, "files"), { recursive: true });
    await writeFile(join(conv1, "old.jsonl"), "x");
    await writeFile(join(conv1, "fresh.jsonl"), "x");
    await writeFile(join(conv1, "files", "old.txt"), "x");
    await writeFile(join(conv1, "files", "new.txt"), "x");
    await age(join(conv1, "old.jsonl"));
    await age(join(conv1, "files", "old.txt"));

    // 会话 2：内容全部过期 → jsonl、附件、乃至整个空壳文件夹都被收尾
    const conv2 = join(root, "topic_oc_a_om_b");
    await mkdir(join(conv2, "files"), { recursive: true });
    await writeFile(join(conv2, "gone.jsonl"), "x");
    await writeFile(join(conv2, "files", "gone.txt"), "x");
    await age(join(conv2, "gone.jsonl"));
    await age(join(conv2, "files", "gone.txt"));

    const stats = await new DataCleaner({ sessionDir: root, retentionDays: 7 }).cleanup();

    expect(stats.sessionsDeleted).toBe(2);
    expect(stats.attachmentsDeleted).toBe(2);
    // 会话 1：未过期内容原样保留
    expect(await readdir(conv1)).toEqual(expect.arrayContaining(["fresh.jsonl", "files"]));
    expect(await readdir(join(conv1, "files"))).toEqual(["new.txt"]);
    // 会话 2：整个文件夹（含空了的 files/）被移除
    expect(await readdir(root)).toEqual(["ou_x-chat_oc_y"]);
  });

  it("根目录平铺的 .jsonl（旧布局遗留）同样纳入清理", async () => {
    const root = await mkdtemp(join(tmpdir(), "clean-"));
    await writeFile(join(root, "legacy.jsonl"), "x");
    await age(join(root, "legacy.jsonl"));

    const stats = await new DataCleaner({ sessionDir: root, retentionDays: 7 }).cleanup();

    expect(stats.sessionsDeleted).toBe(1);
    expect(await readdir(root)).toEqual([]);
  });
});
