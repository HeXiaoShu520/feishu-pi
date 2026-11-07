import { describe, expect, it, vi } from "vitest";
import { MemoryCommand } from "../src/feishu/commands.ts";

describe("飞书私聊记忆管理", () => {
  it("按消息真实用户调用管理接口", async () => {
    const manage = vi.fn().mockResolvedValue([{ id: "abcdef-123456", category: "preference", text: "喜欢草莓", active: false }]);
    const command = new MemoryCommand(manage);
    const message = { text: "/memory disable abcdef", context: { userOpenId: "ou_a", chatId: "chat", conversationId: "p2p-chat", chatMode: "p2p" } };
    const result = await command.execute(message as never);
    expect(manage).toHaveBeenCalledWith(message.context, "disable", "abcdef");
    expect(JSON.stringify(result.card)).toContain("喜欢草莓");
    expect(JSON.stringify(result.card)).toContain("原始聊天");
  });
  it("群聊拒绝执行，参数错误不调用服务", async () => {
    const manage = vi.fn();
    const command = new MemoryCommand(manage);
    await command.execute({ text: "/memory list", context: { chatMode: "group" } } as never);
    await command.execute({ text: "/memory disable", context: { chatMode: "p2p" } } as never);
    expect(manage).not.toHaveBeenCalled();
  });
  it("详情只读取当前私聊用户的记忆并显示转义后的原话", async () => {
    const manage = vi.fn().mockResolvedValue([{ id: "abcdef-123456", category: "称呼偏好", text: "叫小鱼", active: true, evidence: [{ kind: "support", quote: "请叫我<小鱼>", at: Date.parse("2026-11-07T00:00:00Z") }] }]);
    const command = new MemoryCommand(manage);
    const context = { userOpenId: "ou_a", chatMode: "p2p" };
    const result = await command.execute({ text: "/memory show abcdef", context } as never);
    expect(manage).toHaveBeenCalledWith(context, "list", undefined);
    expect(JSON.stringify(result.card)).toContain("原话依据");
    expect(JSON.stringify(result.card)).toContain("小鱼");
  });
});
