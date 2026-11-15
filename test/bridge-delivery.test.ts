import { describe, expect, it, vi } from "vitest";
import type { Client } from "@larksuiteoapi/node-sdk";
import { FeishuAgentBridge } from "../src/feishu/agent-bridge.ts";
import type { FeishuInboundMessage, FeishuTransport } from "../src/feishu/types.ts";
import type { ConversationManager } from "../src/runtime/conversation-manager.ts";
import type { FeishuPiSession } from "../src/runtime/types.ts";

vi.mock("../src/feishu/human-reply.ts", async original => {
  const actual = await original<typeof import("../src/feishu/human-reply.ts")>();
  return { ...actual, sendHumanReply: (client: Parameters<typeof actual.sendHumanReply>[0], params: Parameters<typeof actual.sendHumanReply>[1]) =>
    actual.sendHumanReply(client, { ...params, sleep: async () => {} }) };
});

function setup() {
  const create = vi.fn().mockResolvedValue({ code: 0, data: { message_id: "sent" } });
  const client = { request: vi.fn(async () => ({ code: 0, data: { card_id: "card" } })),
    im: { message: { create, reply: create } } } as unknown as Client;
  const conversations = { prompt: async (_input: unknown, onEvent: Parameters<ConversationManager["prompt"]>[1]) => {
    await onEvent({ type: "assistant_text", text: "这是实际送达的第一条\n\n这是没有送达的第二条" });
    return {} as FeishuPiSession;
  } } as unknown as ConversationManager;
  const memory = { observe: vi.fn(async () => {}) };
  const onDelivered = vi.fn();
  const bridge = new FeishuAgentBridge(conversations, {} as FeishuTransport, { client, memory, onDelivered });
  const message: FeishuInboundMessage = { messageId: "m", chatId: "g", text: "今天聊聊",
    context: { userOpenId: "ou_friend", chatId: "g", chatMode: "group", conversationId: "g-friend" } };
  return { bridge, create, memory, message, onDelivered };
}

describe("回复交付统一收尾", () => {
  it("后续气泡失败，也只记录已送达的前半段", async () => {
    const { bridge, create, memory, message, onDelivered } = setup();
    create.mockResolvedValueOnce({ code: 0 }).mockResolvedValueOnce({ code: 999 });
    await expect(bridge.handle(message)).rejects.toThrow("未送达");
    expect(memory.observe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      assistantText: "这是实际送达的第一条", context: { chatId: "g", chatMode: "group", threadId: undefined },
    }));
    expect(onDelivered).toHaveBeenCalledWith(message, "这是实际送达的第一条");
  });

  it("一条都没送达时不把草稿写进记忆", async () => {
    const { bridge, create, memory, message } = setup();
    create.mockResolvedValueOnce({ code: 999 });
    await expect(bridge.handle(message)).rejects.toThrow("未送达");
    expect(memory.observe).not.toHaveBeenCalled();
  });

  it("附属群活动回调失败不把已发送回复当成发送失败", async () => {
    const { bridge, memory, message, onDelivered } = setup();
    onDelivered.mockImplementation(() => { throw new Error("observer failed"); });
    await expect(bridge.handle(message)).resolves.toBeUndefined();
    expect(memory.observe).toHaveBeenCalledOnce();
  });
});
