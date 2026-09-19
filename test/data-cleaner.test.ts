import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataCleaner } from "../src/runtime/data-cleaner.ts";

/** 把路径（文件或目录）的 mtime 拨到 10 天前（保留期默认 7 天，即视为过期） */
async function age(path: string): Promise<void> {
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await utimes(path, old, old);
}

/** 把整棵目录树（含所有子目录）都拨到 10 天前——模拟整个会话目录长期未使用 */
async function ageTree(path: string): Promise<void> {
  const { stat } = await import("node:fs/promises");
  const entries = (await stat(path)).isDirectory() ? await readdir(path, { withFileTypes: true }) : [];
  for (const entry of entries) await ageTree(join(path, entry.name));
  await age(path);
}

/** 造一个会话目录：历史 jsonl + 附件都在里面 */
async function makeSession(root: string, sessionId: string): Promise<string> {
  const dir = join(root, sessionId);
  await mkdir(join(dir, "files"), { recursive: true });
  await writeFile(join(dir, "session.json"), "{}");
  await writeFile(join(dir, "history.jsonl"), "x");
  await writeFile(join(dir, "files", "报表.xlsx"), "x");
  return dir;
}

describe("DataCleaner 以会话目录为清理单位", () => {
  it("整个会话目录过期就整体删除（历史/附件一起走）", async () => {
    const root = await mkdtemp(join(tmpdir(), "clean-"));
    const expired = await makeSession(root, "20260901-100000-aaaa");
    await ageTree(expired); // 目录树整体停在 10 天前

    const stats = await new DataCleaner({ sessionsRoot: root, retentionDays: 7 }).cleanup();

    expect(stats.sessionsChecked).toBe(1);
    expect(stats.sessionsDeleted).toBe(1);
    expect(await readdir(root)).toEqual([]);
  });

  it("会话目录还在用（树内有新文件）就整体保留，不做文件级删减", async () => {
    const root = await mkdtemp(join(tmpdir(), "clean-"));
    const active = await makeSession(root, "20260901-100000-bbbb");
    await age(join(active, "history.jsonl")); // 老历史
    await age(join(active, "files", "报表.xlsx")); // 老附件
    // 目录本身与其余文件是刚写的 → 最后活跃时间在保留期内

    const stats = await new DataCleaner({ sessionsRoot: root, retentionDays: 7 }).cleanup();

    expect(stats.sessionsDeleted).toBe(0);
    // 目录原样保留：既没有半截会话，也没有被拆散的附件
    expect(await readdir(active)).toEqual(expect.arrayContaining(["history.jsonl", "files"]));
    expect(await readdir(join(active, "files"))).toEqual(["报表.xlsx"]);
  });

  it("根目录下散落的文件（旧布局遗留）按 mtime 清理", async () => {
    const root = await mkdtemp(join(tmpdir(), "clean-"));
    await writeFile(join(root, "legacy.jsonl"), "x");
    await age(join(root, "legacy.jsonl"));
    await writeFile(join(root, "fresh.jsonl"), "x");

    const stats = await new DataCleaner({ sessionsRoot: root, retentionDays: 7 }).cleanup();

    expect(stats.sessionsDeleted).toBe(1);
    expect(await readdir(root)).toEqual(["fresh.jsonl"]);
  });

  it("消息去重表按 updatedAt 随同一保留期清理，不碰会话之外的其他数据", async () => {
    const root = await mkdtemp(join(tmpdir(), "clean-"));
    const messagesFile = join(root, "messages.json");
    await writeFile(
      messagesFile,
      JSON.stringify({
        old: { status: "completed", updatedAt: Date.now() - 10 * 24 * 60 * 60 * 1000 },
        fresh: { status: "completed", updatedAt: Date.now() },
      }),
    );

    const stats = await new DataCleaner({ sessionsRoot: join(root, "sessions"), messagesFile, retentionDays: 7 }).cleanup();

    expect(stats.messagesChecked).toBe(2);
    expect(stats.messagesCleaned).toBe(1);
  });

  it("会话目录不存在时静默返回（首次运行）", async () => {
    const root = await mkdtemp(join(tmpdir(), "clean-"));
    const stats = await new DataCleaner({ sessionsRoot: join(root, "nope"), retentionDays: 7 }).cleanup();
    expect(stats.sessionsDeleted).toBe(0);
  });
});
