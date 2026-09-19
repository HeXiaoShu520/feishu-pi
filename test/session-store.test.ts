import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/runtime/session-store.ts";
import { SESSION_META_FILE } from "../src/utils/session-paths.ts";

async function makeStore(): Promise<{ store: SessionStore; root: string; indexFile: string }> {
  const base = await mkdtemp(join(tmpdir(), "feishu-pi-session-"));
  const root = join(base, "work_space");
  const indexFile = join(base, "sessions.json");
  return { store: new SessionStore(indexFile, root), root, indexFile };
}

describe("SessionStore 会话注册表", () => {
  it("首次使用时建立会话目录，同一会话复用同一个目录", async () => {
    const { store, root } = await makeStore();

    const first = await store.getOrCreate("p2p-oc_1");
    const again = await store.getOrCreate("p2p-oc_1");

    expect(again.sessionId).toBe(first.sessionId);
    expect(again.dir).toBe(first.dir);
    expect(await readdir(root)).toEqual([first.sessionId]);

    // 目录自述文件写明会话 id 与所属会话，便于人工辨识
    const meta = JSON.parse(await readFile(join(first.dir, SESSION_META_FILE), "utf8"));
    expect(meta).toMatchObject({ sessionId: first.sessionId, conversationId: "p2p-oc_1" });
  });

  it("/new 换代：新会话 id + 新目录 + 空历史，旧目录留在磁盘上等过期清理", async () => {
    const { store, root } = await makeStore();
    const before = await store.getOrCreate("p2p-oc_1");
    await store.setSessionFile("p2p-oc_1", join(before.dir, "a.jsonl"), before.sessionId);

    const after = await store.rotate("p2p-oc_1");

    expect(after.sessionId).not.toBe(before.sessionId);
    expect(after.dir).not.toBe(before.dir);
    expect(after.sessionFile).toBeUndefined();
    expect((await store.getOrCreate("p2p-oc_1")).sessionId).toBe(after.sessionId);
    // 新老目录同时存在：旧的不会被立即删除，交给保留期清理
    expect((await readdir(root)).sort()).toEqual([before.sessionId, after.sessionId].sort());
  });

  it("上一代会话的孤儿任务不能把旧会话文件写回新记录", async () => {
    const { store } = await makeStore();
    const before = await store.getOrCreate("p2p-oc_1");
    const after = await store.rotate("p2p-oc_1");

    await store.setSessionFile("p2p-oc_1", join(before.dir, "stale.jsonl"), before.sessionId);

    expect((await store.getOrCreate("p2p-oc_1")).sessionFile).toBeUndefined();
    await store.setSessionFile("p2p-oc_1", join(after.dir, "fresh.jsonl"), after.sessionId);
    expect((await store.getOrCreate("p2p-oc_1")).sessionFile).toBe(join(after.dir, "fresh.jsonl"));
  });

  it("会话目录被清理掉后，下一次使用自动重建会话", async () => {
    const { store } = await makeStore();
    const first = await store.getOrCreate("p2p-oc_1");
    await rm(first.dir, { recursive: true, force: true });

    const rebuilt = await store.getOrCreate("p2p-oc_1");
    expect(rebuilt.sessionId).not.toBe(first.sessionId);
  });

  it("登记信息落盘，进程重启后仍然是同一个会话目录", async () => {
    const { store, root, indexFile } = await makeStore();
    const before = await store.getOrCreate("p2p-oc_1");
    await store.setSessionFile("p2p-oc_1", join(before.dir, "a.jsonl"), before.sessionId);

    const reopened = new SessionStore(indexFile, root);
    const restored = await reopened.getOrCreate("p2p-oc_1");

    expect(restored.sessionId).toBe(before.sessionId);
    expect(restored.sessionFile).toBe(join(before.dir, "a.jsonl"));
  });
});
