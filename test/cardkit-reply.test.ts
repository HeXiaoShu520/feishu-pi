import { describe, expect, it, vi } from "vitest";
import type { Client } from "@larksuiteoapi/node-sdk";
import { CardKitReply } from "../src/feishu/cardkit-reply.ts";

/** CardKitReply 的网络面：CardKit REST（request）+ 卡片消息（reply/create）+ 撤回（v1 delete） */
function fakeClient() {
  const request = vi.fn().mockResolvedValue({ code: 0, data: { card_id: "card_1" } });
  const reply = vi.fn().mockResolvedValue({ code: 0, data: { message_id: "om_card" } });
  const send = vi.fn().mockResolvedValue({ code: 0, data: { message_id: "om_direct" } });
  const remove = vi.fn().mockResolvedValue({});
  const client = { request, im: { message: { reply, create: send }, v1: { message: { delete: remove } } } } as unknown as Client;
  return { client, request, reply, send, remove };
}

describe("CardKitReply 惰性出卡（先不响应，有结果再回）", () => {
  it("recall 在卡片从未创建时静默完成，不发任何消息", async () => {
    const { client, request, reply } = fakeClient();
    const card = new CardKitReply({ client, chatId: "oc_1" });
    await card.recall();
    expect(reply).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("close 在卡片从未创建时补建卡写入终态（错误路径必须可见）", async () => {
    const { client, request, send } = fakeClient();
    const card = new CardKitReply({ client, chatId: "oc_1" });
    await card.close("处理失败：测试");
    expect(send).toHaveBeenCalledOnce();
    expect(card.isDelivered).toBe(true);
    expect(JSON.stringify(request.mock.calls)).toContain("处理失败：测试");
  });

  it("建卡后 recall 撤回已发送的卡片消息", async () => {
    const { client, reply, remove } = fakeClient();
    const card = new CardKitReply({ client, chatId: "oc_1", messageId: "om_user" });
    await card.update("你好");
    expect(reply).toHaveBeenCalledOnce();
    await card.recall();
    expect(remove).toHaveBeenCalledWith({ path: { message_id: "om_card" } });
  });
});

describe("卡片发送回执", () => {
  it("接口返回业务失败，即使故障提示成功也不算正文发送成功", async () => {
    const { client, request } = fakeClient();
    request.mockImplementation(async (args: { method: string; url: string }) =>
      args.method === "PUT" && args.url.endsWith("/card_1")
        ? { code: 999, data: {} } : { code: 0, data: { card_id: "card_1" } });
    const fallback = vi.fn(async () => {});
    const card = new CardKitReply({ client, chatId: "oc_1", fallbackNotice: fallback });
    await card.close("![图](img_1)");
    expect(card.isDelivered).toBe(false);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("没有消息 ID 不能确认发送；撤回后也不能确认", async () => {
    const { client, send } = fakeClient();
    send.mockResolvedValueOnce({ code: 0, data: {} });
    const failed = new CardKitReply({ client, chatId: "oc_1" });
    await expect(failed.close("图片")).rejects.toThrow("回执");
    expect(failed.isDelivered).toBe(false);
    const success = new CardKitReply({ client, chatId: "oc_1" });
    await success.close("图片");
    expect(success.isDelivered).toBe(true);
    await success.recall();
    expect(success.isDelivered).toBe(false);
  });
});
