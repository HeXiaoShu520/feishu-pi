import { describe, expect, it, vi } from "vitest";
import { LarkTransport } from "../src/feishu/lark-transport.ts";

describe("普通用户群消息", () => {
  it("只响应 @ 机器人的消息，并为每个普通用户创建独立群会话", async () => {
    const sessionDirs = { dirFor: vi.fn().mockResolvedValue("test-dir") };
    const transport = new LarkTransport({ appId: "app", appSecret: "secret", botOpenId: "ou_bot", ownerOpenId: "ou_admin", client: {} as never, sessions: sessionDirs as never });
    const internal = transport as unknown as {
      getChatModeCached: () => Promise<string>;
      larkCli: { getUserProfile: () => Promise<object> };
      dispatchMessage: (message: unknown) => Promise<void>;
    };
    internal.getChatModeCached = async () => "group";
    internal.larkCli.getUserProfile = async () => ({ name: "访客" });
    const received = vi.fn().mockResolvedValue(undefined);
    transport.onMessage(received);
    const base = { chatId: "oc_group", senderId: "ou_a", messageId: "om_1", chatType: "group", content: "你好", rawContentType: "text", resources: [], mentions: [], mentionedBot: false };
    await internal.dispatchMessage(base);
    expect(received).not.toHaveBeenCalled();
    await internal.dispatchMessage({ ...base, messageId: "om_2", mentionedBot: true });
    await internal.dispatchMessage({ ...base, messageId: "om_3", senderId: "ou_b", mentionedBot: true });
    expect(received).toHaveBeenCalledTimes(2);
    expect(received.mock.calls[0][0].context.conversationId).toBe("group-oc_group:guest:ou_a");
    expect(received.mock.calls[1][0].context.conversationId).toBe("group-oc_group:guest:ou_b");
    expect(received.mock.calls[0][0].context.isOwner).toBe(false);
  });
});
