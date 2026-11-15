import { describe, expect, it, vi } from "vitest";
import { sendHumanReply, shouldUseCard, splitHumanReply, typingDelay } from "../src/feishu/human-reply.ts";

describe("拟人化文本回复", () => {
  it("短闲聊保持一条，不拆", () => {
    expect(splitHumanReply("在。说")).toEqual(["在。说"]);
  });

  it("长回复按句切开并最多三条", () => {
    const text = "第一句话说明今天发生的事情，细节还挺多的，先讲这么多吧。第二句补充一点背景信息，免得你听不明白前因后果。第三句继续解释中间的过程，这里也有不少值得说的。第四句给出结论，也就是我们现在该怎么办。第五句是多余的补充，按理说可以不用说。";
    const parts = splitHumanReply(text);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain("第一句");
    expect(parts[2]).toContain("第五句");
  });

  it("只有长内容或 Markdown 才走卡片", () => {
    expect(shouldUseCard("那就躺平，白饭分你一半")).toBe(false);
    expect(shouldUseCard("```ts\nconst a = 1;\n```")).toBe(true);
    expect(shouldUseCard("**结论**：少个引号")).toBe(true);
    expect(shouldUseCard("啊".repeat(300))).toBe(true);
  });

  it("只为多个气泡之间估计停顿", () => {
    const short = typingDelay("短", () => 0.5);
    const longer = typingDelay("这是一句明显更长的话，用来检查等待时间", () => 0.5);
    expect(longer).toBeGreaterThan(short);
  });

  it("普通群直接发到会话，话题群回进线程", async () => {
    const create = vi.fn().mockResolvedValue({});
    const reply = vi.fn().mockResolvedValue({});
    const client = { im: { message: { create, reply } } };
    const wait = vi.fn().mockResolvedValue(undefined);

    await sendHumanReply(client, { chatId: "oc_1", messageId: "om_1", text: "一句。两句。", replyInThread: false, sleep: wait });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      params: { receive_id_type: "chat_id" },
      data: expect.objectContaining({ receive_id: "oc_1", msg_type: "text", uuid: expect.any(String) }),
    }));
    expect(reply).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();

    await sendHumanReply(client, { chatId: "oc_1", messageId: "om_1", text: "一句。", replyInThread: true, sleep: wait });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      path: { message_id: "om_1" },
      data: expect.objectContaining({ msg_type: "text", reply_in_thread: true }),
    }));
  });

  it("等待打字时有新消息，停止发送过时回复", async () => {
    const create = vi.fn(async () => ({ code: 0 }));
    const reply = vi.fn(async () => ({ code: 0 }));
    let current = true;
    const sent = await sendHumanReply({ im: { message: { create, reply } } }, {
      chatId: "g", messageId: "m", text: "先发出去的第一条回复\n\n后续已经过时的第二条回复", replyInThread: false,
      shouldContinue: () => current, sleep: async () => { current = false; },
    });
    expect(sent).toBe(1);
    expect(create).toHaveBeenCalledOnce();
  });

  it("业务失败不记录为已送达", async () => {
    const create = vi.fn(async () => ({ code: 999 }));
    const reply = vi.fn(async () => ({}));
    const delivered = vi.fn();
    await expect(sendHumanReply({ im: { message: { create, reply } } }, {
      chatId: "g", messageId: "m", text: "一句话", replyInThread: false, sleep: async () => {}, onDelivered: delivered,
    })).rejects.toThrow("未送达");
    expect(delivered).not.toHaveBeenCalled();
  });

  it("后续发送失败仍保留前面成功的送达通知", async () => {
    const create = vi.fn().mockResolvedValueOnce({ code: 0 }).mockResolvedValueOnce({ code: 999 });
    const reply = vi.fn(async () => ({}));
    const delivered = vi.fn();
    await expect(sendHumanReply({ im: { message: { create, reply } } }, {
      chatId: "g", messageId: "m", text: "这是已经送达的第一条\n\n这是没有送达的第二条", replyInThread: false,
      sleep: async () => {}, onDelivered: delivered,
    })).rejects.toThrow("未送达");
    expect(delivered.mock.calls).toEqual([["这是已经送达的第一条"]]);
  });
});
