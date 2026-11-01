import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuPiRuntime } from "../src/runtime/feishu-pi-runtime.ts";
import type { FeishuPiConfig } from "../src/runtime/types.ts";
import { PersonMemory } from "../src/assistant/person-memory.ts";

describe("普通用户权限", () => {
  it("普通用户可私聊和群聊，只注册安全表情工具", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-session-"));
    const previous = process.env.FEISHU_PI_MODEL_API_KEY;
    process.env.FEISHU_PI_MODEL_API_KEY = "test-key";
    try {
      const config = {
        cwd: process.cwd(), ownerOpenId: "ou_owner", modelProvider: "deepseek", modelName: "deepseek-flash",
        thinkingLevel: "off", sessions: { dirFor: async () => dir }, permissionPolicy: { current: async () => ({}) },
        toolGuard: async () => undefined,
        guestTools: () => ["sticker_search", "sticker_send", "bash"].map(name => ({ name, label: name, description: name, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) })),
      } as unknown as FeishuPiConfig;
      const runtime = new FeishuPiRuntime(config);
      const context = { userOpenId: "ou_guest", chatId: "oc_guest", conversationId: "p2p-guest", chatMode: "p2p" as const, isOwner: false };
      const session = await runtime.createSession(undefined, "ou_guest", context);
      const raw = (session as unknown as { raw: { agent: { state: { tools: Array<{ name: string }> }; beforeToolCall: (ctx: unknown, signal: AbortSignal) => Promise<unknown> } } }).raw;
      expect(raw.agent.state.tools.map(tool => tool.name).sort()).toEqual(["sticker_search", "sticker_send"]);
      const signal = new AbortController().signal;
      expect(await raw.agent.beforeToolCall({ toolCall: { name: "sticker_send" }, args: {} }, signal)).toBeUndefined();
      expect(await raw.agent.beforeToolCall({ toolCall: { name: "bash" }, args: {} }, signal)).toMatchObject({ block: true });
      const groupContext = { ...context, chatMode: "group" as const, conversationId: "group-oc:guest:ou_guest" };
      const groupSession = await runtime.createSession(undefined, "ou_guest", groupContext);
      const groupRaw = (groupSession as unknown as { raw: { agent: { state: { tools: Array<{ name: string }> } } } }).raw;
      expect(groupRaw.agent.state.tools.map(tool => tool.name).sort()).toEqual(["sticker_search", "sticker_send"]);
      const groupMemory = (groupSession as unknown as { memory: { recall(query: string): Promise<string> } }).memory;
      await expect(runtime.createSession(undefined, "ou_guest", { ...context, userOpenId: "ou_other" })).rejects.toThrow();
      const ownerSession = await runtime.createSession(undefined, "ou_owner", { ...context, userOpenId: "ou_owner", isOwner: true });
      const ownerRaw = (ownerSession as unknown as { raw: { agent: { state: { tools: Array<{ name: string }> } } } }).raw;
      expect(ownerRaw.agent.state.tools.map(tool => tool.name)).toContain("sticker_search");
      expect(ownerRaw.agent.state.tools.map(tool => tool.name)).toContain("bash");
      const people = new PersonMemory(join(dir, "people"), async () => JSON.stringify([{ op: "add", category: "preference", text: "喜欢草莓", importance: 2 }]));
      (runtime as unknown as { personMemory: PersonMemory }).personMemory = people;
      await people.observe("feishu", "ou_guest", "喜欢草莓", "好的", []);
      const [fact] = await runtime.manageMemory(context, "list");
      await expect(runtime.manageMemory({ ...context, userOpenId: "ou_other", isOwner: true }, "disable", fact.id)).rejects.toThrow("没有找到");
      expect((await runtime.manageMemory(context, "list"))[0].active).toBe(true);
      expect(await people.recall("feishu-group", "oc_guest:ou_guest", "草莓")).toBe("");
      expect(await groupMemory.recall("草莓")).not.toContain("草莓");
    } finally {
      if (previous === undefined) delete process.env.FEISHU_PI_MODEL_API_KEY; else process.env.FEISHU_PI_MODEL_API_KEY = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
