import { describe, expect, it, vi } from "vitest";
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


function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("会话并发与身份回归", () => {
  it("并发投递同一消息只有一个请求能认领", async () => {
    const dir = await mkdtemp(join(tmpdir(), "message-race-"));
    const store = new MessageStore(join(dir, "messages.json"));
    const results = await Promise.all(Array.from({ length: 20 }, () => store.claim("same")));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("初始化失败后下一条消息可以重试", async () => {
    const createSession = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(new FakeSession());
    const manager = new ConversationManager({ createSession } as never, await makeSessions());
    const message = { conversationId: "chat:retry", prompt: { text: "hi" } };
    await expect(manager.prompt(message, () => {})).rejects.toThrow("temporary");
    await manager.prompt(message, () => {});
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it("共享群换人时复用历史，重新绑定当前调用者", async () => {
    const createSession = vi.fn(async () => new FakeSession());
    const manager = new ConversationManager({ createSession } as never, await makeSessions());
    for (const userOpenId of ["ou_admin", "ou_user", "ou_user"]) {
      await manager.prompt({ conversationId: "group-oc", context: { conversationId: "group-oc", chatId: "oc", userOpenId }, prompt: { text: "hi" } }, () => {});
    }
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession.mock.calls[1]).toEqual(["data/sessions/session.jsonl", "ou_user", expect.objectContaining({ userOpenId: "ou_user" })]);
  });

  it("异步事件按顺序消费并在 prompt 返回前完成", async () => {
    const gate = deferred();
    let listener: (event: FeishuPiEvent) => void = () => {};
    const session = new FakeSession();
    session.subscribe = (fn) => { listener = fn; return () => {}; };
    session.prompt = async () => {
      listener({ type: "assistant_text", text: "first" });
      listener({ type: "assistant_text", text: "last" });
    };
    const manager = new ConversationManager({ createSession: async () => session } as never, await makeSessions());
    const seen: string[] = [];
    let done = false;
    const task = manager.prompt({ conversationId: "chat:events", prompt: { text: "hi" } }, async (event) => {
      await gate.promise;
      if (event.type === "assistant_text") seen.push(event.text);
    }).then(() => { done = true; });
    await vi.waitFor(() => expect(manager.size).toBe(1));
    expect(done).toBe(false);
    gate.resolve();
    await task;
    expect(seen).toEqual(["first", "last"]);
  });

  it("上一轮结束后，排队的新一轮仍可中断且不会被驱逐", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    const session = new FakeSession();
    session.prompt = async (input) => { const i = started.length; started.push(input.text); await gates[i].promise; };
    const manager = new ConversationManager({ createSession: async () => session } as never, await makeSessions());
    const interrupted = vi.fn();
    const send = (text: string, onInterrupted?: () => void) => manager.prompt({ conversationId: "chat:busy", prompt: { text } }, () => {}, onInterrupted);
    const first = send("first");
    await vi.waitFor(() => expect(started).toHaveLength(1));
    const second = send("second", interrupted);
    gates[0].resolve();
    await first;
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(await manager.evictIdle(0)).toBe(0);
    const third = send("third");
    await vi.waitFor(() => expect(interrupted).toHaveBeenCalledOnce());
    gates[1].resolve();
    await second;
    gates[2].resolve();
    await third;
  });
});
