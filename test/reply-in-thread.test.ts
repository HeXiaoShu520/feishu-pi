import { describe, expect, it } from "vitest";
import type { Client } from "@larksuiteoapi/node-sdk";
import { CardKitReply, resolveReplyInThread } from "../src/feishu/cardkit-reply.ts";

describe("resolveReplyInThread：回复是否以话题形式发出", () => {
  it("话题群一律话题形式——包括没有 threadId 的话题根消息（否则会另开新话题）", () => {
    expect(resolveReplyInThread("topic", undefined)).toBe(true);
    expect(resolveReplyInThread("topic", "om_root")).toBe(true);
  });

  it("私聊/普通群默认普通回复，仅当消息本身在线程内才跟随线程", () => {
    expect(resolveReplyInThread("p2p", undefined)).toBe(false);
    expect(resolveReplyInThread("group", undefined)).toBe(false);
    expect(resolveReplyInThread("group", "om_thread_root")).toBe(true);
    // chatMode 缺失（旧数据/异常路径）按消息自身形态兜底
    expect(resolveReplyInThread(undefined, undefined)).toBe(false);
  });
});

/** 捕获 reply 调用参数的假 Lark Client：cardkit create 返回固定 card_id */
function makeCapturingClient(replies: Array<{ path?: { message_id?: string }; data?: Record<string, unknown> }>) {
  return {
    request: async () => ({ data: { card_id: "card_test_1" } }),
    im: {
      message: {
        reply: async (args: { path?: { message_id?: string }; data?: Record<string, unknown> }) => {
          replies.push(args);
          return {};
        },
      },
    },
  } as unknown as Client;
}

describe("CardKitReply 传递 reply_in_thread", () => {
  it("replyInThread=true 时回复参数带 reply_in_thread:true", async () => {
    const replies: Array<{ path?: { message_id?: string }; data?: Record<string, unknown> }> = [];
    const reply = new CardKitReply({
      client: makeCapturingClient(replies),
      chatId: "oc_chat",
      messageId: "om_msg",
      replyInThread: true,
    });
    await reply.update("你好");
    expect(replies).toHaveLength(1);
    expect(replies[0].path?.message_id).toBe("om_msg");
    expect(replies[0].data?.reply_in_thread).toBe(true);
  });

  it("replyInThread=false（普通交流）时回复参数为 reply_in_thread:false", async () => {
    const replies: Array<{ path?: { message_id?: string }; data?: Record<string, unknown> }> = [];
    const reply = new CardKitReply({
      client: makeCapturingClient(replies),
      chatId: "oc_chat",
      messageId: "om_msg",
      replyInThread: false,
    });
    await reply.update("你好");
    expect(replies).toHaveLength(1);
    expect(replies[0].data?.reply_in_thread).toBe(false);
  });
});
