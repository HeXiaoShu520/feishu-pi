import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuPiRuntime } from "../src/runtime/feishu-pi-runtime.ts";
import type { FeishuPiConfig } from "../src/runtime/types.ts";

describe("普通用户权限", () => {
  it("普通用户可私聊和群聊，只注册安全表情工具", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-session-"));
    const previous = process.env.FEISHU_PI_MODEL_API_KEY;
    process.env.FEISHU_PI_MODEL_API_KEY = "test-key";
    try {
      const fakeTool = (name: string) => ({ name, label: name, description: name, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
      const config = {
        cwd: process.cwd(), ownerOpenId: "ou_owner", modelProvider: "deepseek", modelName: "deepseek-flash",
        thinkingLevel: "off", sessions: { dirFor: async () => dir }, permissionPolicy: { current: async () => ({}) },
        toolGuard: async () => undefined,
        guestTools: () => ["sticker_search", "sticker_send", "bash", "profile_update"].map(fakeTool),
        // 与生产装配对齐（main.ts）：owner 的 sticker 工具来自 sessionTools，而非 .agent/tools 里的同名脚本
        sessionTools: () => ["sticker_search", "sticker_send"].map(fakeTool),
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
      await expect(runtime.createSession(undefined, "ou_guest", { ...context, userOpenId: "ou_other" })).rejects.toThrow();
      const ownerSession = await runtime.createSession(undefined, "ou_owner", { ...context, userOpenId: "ou_owner", isOwner: true });
      const ownerRaw = (ownerSession as unknown as { raw: { agent: { state: { tools: Array<{ name: string }> } } } }).raw;
      expect(ownerRaw.agent.state.tools.map(tool => tool.name)).toContain("sticker_search");
      expect(ownerRaw.agent.state.tools.map(tool => tool.name)).toContain("bash");
      runtime.setMemory({ recall: async () => "", updateProfile: async () => "profile-id" });
      const withMemory = await runtime.createSession(undefined, "ou_guest", context);
      const memoryRaw = (withMemory as unknown as { raw: typeof raw }).raw;
      expect(memoryRaw.agent.state.tools.map(tool => tool.name).sort()).toEqual(["profile_update", "sticker_search", "sticker_send"]);
      expect(await memoryRaw.agent.beforeToolCall({ toolCall: { name: "profile_update" }, args: {} }, signal)).toBeUndefined();
      expect(await memoryRaw.agent.beforeToolCall({ toolCall: { name: "bash" }, args: {} }, signal)).toMatchObject({ block: true });
    } finally {
      if (previous === undefined) delete process.env.FEISHU_PI_MODEL_API_KEY; else process.env.FEISHU_PI_MODEL_API_KEY = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
