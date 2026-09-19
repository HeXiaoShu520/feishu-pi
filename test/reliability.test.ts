import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationManager } from "../src/runtime/conversation-manager.ts";
import { SessionStore } from "../src/runtime/session-store.ts";
import { MessageStore } from "../src/feishu/message-store.ts";
import type { FeishuPiPrompt, FeishuPiSession, FeishuPiEvent } from "../src/runtime/types.ts";

/** 造一个临时会话注册表（会话目录根 + 路由表都在临时目录下） */
async function makeSessions(): Promise<SessionStore> {
  const base = await mkdtemp(join(tmpdir(), "feishu-pi-sessions-"));
  return new SessionStore(join(base, "sessions.json"), join(base, "work_space"));
}

class FakeSession implements FeishuPiSession {
  readonly sessionFile = "data/sessions/session.jsonl";
  async prompt(_input: FeishuPiPrompt): Promise<void> {}
  async waitForIdle(): Promise<void> {}
  abort(): void {}
  getStats(): any { return {}; }
  subscribe(_listener: (event: FeishuPiEvent) => void): () => void { return () => undefined; }
}

class FakeRuntime {
  createCount = 0;
  /** 最近一次会话创建时所在的会话目录（验证 jsonl 落在会话目录里） */
  lastDir?: string;
  sessions?: SessionStore;
  async createSession(_sessionFile?: string, _userId?: string, context?: { conversationId?: string }): Promise<FeishuPiSession> {
    this.createCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.lastDir = await this.sessions?.dirFor(context?.conversationId ?? "default");
    return new FakeSession();
  }
}

describe("reliability stores", () => {
  it("creates one session for concurrent first messages", async () => {
    const runtime = new FakeRuntime();
    const manager = new ConversationManager(runtime as never, await makeSessions());
    await Promise.all([
      manager.prompt({ conversationId: "chat:a", prompt: { text: "one" } }, () => undefined),
      manager.prompt({ conversationId: "chat:a", prompt: { text: "two" } }, () => undefined),
    ]);
    expect(runtime.createCount).toBe(1);
  });

  it("claims a message only once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feishu-pi-message-"));
    const store = new MessageStore(join(directory, "messages.json"));
    expect(await store.claim("message-1")).toBe(true);
    expect(await store.claim("message-1")).toBe(false);
    await store.complete("message-1");
    expect(await store.claim("message-1")).toBe(false);
  });

  it("/new 换代后重建会话，且落在新的会话目录", async () => {
    const sessions = await makeSessions();
    const runtime = new FakeRuntime();
    runtime.sessions = sessions;
    const manager = new ConversationManager(runtime as never, sessions);

    const context = { conversationId: "chat:a", userOpenId: "ou_1", chatId: "oc_1" };
    await manager.prompt({ conversationId: "chat:a", context, prompt: { text: "hi" } }, () => undefined);
    const before = await sessions.getOrCreate("chat:a");
    expect(runtime.createCount).toBe(1);

    await manager.reset("chat:a");
    const rotated = await sessions.getOrCreate("chat:a");
    expect(rotated.sessionId).not.toBe(before.sessionId);
    expect(manager.size).toBe(0); // 旧状态已从内存移除，下一条消息按新会话初始化

    await manager.prompt({ conversationId: "chat:a", context, prompt: { text: "again" } }, () => undefined);
    expect(runtime.createCount).toBe(2);
    expect(runtime.lastDir).toBe(rotated.dir);
    expect(runtime.lastDir).not.toBe(before.dir);
  });

  it("evicts idle conversations; session is recreated on next message", async () => {
    const runtime = new FakeRuntime();
    const manager = new ConversationManager(runtime as never, await makeSessions());
    await manager.prompt({ conversationId: "chat:a", prompt: { text: "hi" } }, () => undefined);
    expect(manager.size).toBe(1);

    // 刚活跃的会话不驱逐；空闲阈值归零后驱逐
    expect(await manager.evictIdle(60_000)).toBe(0);
    expect(await manager.evictIdle(0)).toBe(1);
    expect(manager.size).toBe(0);

    // 驱逐后再来消息：从磁盘映射重建会话（createCount 增加）
    await manager.prompt({ conversationId: "chat:a", prompt: { text: "back" } }, () => undefined);
    expect(runtime.createCount).toBe(2);
  });
});
