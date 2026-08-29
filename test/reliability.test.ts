import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationManager } from "../src/runtime/conversation-manager.ts";
import { ConversationStore } from "../src/runtime/conversation-store.ts";
import { MessageStore } from "../src/feishu/message-store.ts";
import type { FeishuPiPrompt, FeishuPiSession, FeishuPiEvent } from "../src/runtime/types.ts";

class FakeSession implements FeishuPiSession {
  readonly sessionFile = "data/sessions/session.jsonl";
  async prompt(_input: FeishuPiPrompt): Promise<void> {}
  async waitForIdle(): Promise<void> {}
  subscribe(_listener: (event: FeishuPiEvent) => void): () => void { return () => undefined; }
}

class FakeRuntime {
  createCount = 0;
  async createSession(_sessionFile?: string): Promise<FeishuPiSession> {
    this.createCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new FakeSession();
  }
}

describe("reliability stores", () => {
  it("creates one session for concurrent first messages", async () => {
    const runtime = new FakeRuntime();
    const manager = new ConversationManager(runtime as never);
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

  it("persists conversation session mappings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feishu-pi-conversation-"));
    const filePath = join(directory, "conversations.json");
    const store = new ConversationStore(filePath);
    await store.set("chat:a", "data/sessions/a.jsonl");
    const restored = new ConversationStore(filePath);
    expect(await restored.get("chat:a")).toBe("data/sessions/a.jsonl");
  });
});
