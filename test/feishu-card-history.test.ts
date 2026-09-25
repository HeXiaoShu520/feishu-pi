import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardMentionIds, cardMentionNames, cardVisibleText, expandCardMentions } from "../src/feishu/inbound-content.ts";
import { enrichFeishuHistory, isFeishuHistoryRead } from "../src/feishu/history-card-content.ts";
import { createHistoryCardReader } from "../src/feishu/history-card-reader.ts";

afterEach(() => vi.unstubAllGlobals());

describe("飞书卡片人物与历史原文", () => {
  it("卡片中的原生提及交给模型时包含姓名和 open_id", () => {
    const names = new Map([["ou_zhang", "张三"]]);
    expect(expandCardMentions("请<at id=ou_zhang></at>处理", names)).toBe("请张三(ou_zhang)处理");
  });

  it("多人提及按正文位置对应 ID，重复提及保留，机器人自己的 ID 排除", () => {
    const source = "先<at id=ou_a></at>，再<at id=ou_bot></at>，然后<at id=\"ou_b\"></at>，最后<at id=ou_a></at>";
    const attachment = JSON.stringify({ json_attachment: JSON.stringify({ persons: {
      ou_b: { content: "乙" }, ou_bot: { content: "机器人" }, ou_a: { content: "甲" },
    } }) });
    const names = cardMentionNames(attachment);
    expect(cardMentionIds(source, "ou_bot")).toEqual(["ou_a", "ou_b"]);
    expect(expandCardMentions(source, names, "ou_bot"))
      .toBe("先甲(ou_a)，再，然后乙(ou_b)，最后甲(ou_a)");
    const many = Array.from({ length: 25 }, (_, index) => `<at id=ou_${index}></at>`).join("、");
    expect(cardMentionIds(many)).toHaveLength(25);
  });

  it("Card 2.0 消息原文可提取可见文字", () => {
    const content = JSON.stringify({ json_card: JSON.stringify({ schema: "2.0", header: { title: { content: "审批" } }, body: { elements: [{ tag: "markdown", content: "请<at id=ou_zhang></at>确认" }] } }) });
    expect(cardVisibleText(content)).toBe("审批\n请<at id=ou_zhang></at>确认");
    const repeated = JSON.stringify({ schema: "2.0", body: { elements: [
      { tag: "markdown", content: "<at id=ou_zhang></at>" },
      { tag: "markdown", content: "<at id=ou_zhang></at>" },
    ] } });
    expect(cardVisibleText(repeated)).toBe("<at id=ou_zhang></at>\n<at id=ou_zhang></at>");
  });

  it("聊天历史中的卡片被原文替换，发言人和普通 @ 保留姓名及 ID", async () => {
    const output = JSON.stringify({ ok: true, data: { messages: [
      { message_id: "om_card", msg_type: "interactive", sender: { id: "ou_alice", name: "何某某" }, content: "[interactive card]", body: { content: '{"type":"card","data":{"card_id":"card_1"}}' } },
      { message_id: "om_text", msg_type: "text", sender: { id: "ou_bob", name: "李某某" }, content: "请@张三处理", mentions: [{ id: "ou_zhang", name: "张三" }] },
    ] } });
    const result = JSON.parse(await enrichFeishuHistory(output, async (id) => id === "om_card" ? "请张三(ou_zhang)确认" : undefined));
    expect(result.data.messages[0]).toMatchObject({ speaker: "何某某(ou_alice)", content: "[卡片内容]\n请张三(ou_zhang)确认" });
    expect(result.data.messages[0].body.content).toBe("[卡片内容]\n请张三(ou_zhang)确认");
    expect(result.data.messages[1]).toMatchObject({ speaker: "李某某(ou_bob)", content: "请@张三(ou_zhang)处理" });
  });

  it("只处理读取飞书消息的 CLI 命令", () => {
    expect(isFeishuHistoryRead(["im", "+chat-messages-list", "--chat-id", "oc_x"])).toBe(true);
    expect(isFeishuHistoryRead(["--as", "bot", "im", "+messages-mget", "--message-ids", "om_x"])).toBe(true);
    expect(isFeishuHistoryRead(["im", "+messages-send", "--text", "hi"])).toBe(false);
  });

  it("用户态历史卡片用该用户令牌读取原文并展开人物", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mini-claw-card-history-"));
    const card = JSON.stringify({ schema: "2.0", body: { elements: [{ tag: "markdown", content: "<at id=ou_bot></at>请<at id=ou_zhang></at>与<at id=ou_li></at>确认" }] } });
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { items: [{ body: { content: JSON.stringify({ json_card: card }) }, mentions: [
      { id: { open_id: "ou_bot" }, name: "机器人" },
      { id: { open_id: "ou_zhang" }, name: "张三" },
      { id: { open_id: "ou_li" }, name: "李四" },
    ] }] } }) }));
    vi.stubGlobal("fetch", fetchMock);
    const read = createHistoryCardReader({ cwd, appId: "cli_test", appSecret: "unused", botOpenId: "ou_bot", userToken: "user-token" });
    expect(await read("om_card")).toBe("请张三(ou_zhang)与李四(ou_li)确认");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_card?card_msg_content_type=user_card_content",
      expect.objectContaining({ headers: { Authorization: "Bearer user-token" } }),
    );
  });
});
