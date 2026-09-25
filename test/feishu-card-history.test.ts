import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardVisibleText, expandCardMentions, renderCardPeople, renderTextPeople } from "../src/feishu/inbound-content.ts";
import { enrichFeishuHistory, isFeishuHistoryRead } from "../src/feishu/history-card-content.ts";
import { createHistoryCardReader } from "../src/feishu/history-card-reader.ts";

afterEach(() => vi.unstubAllGlobals());

describe("飞书卡片人物与历史原文", () => {
  it("模型看到姓名和 open_id，飞书卡片只显示原生蓝色人物标签", () => {
    const names = new Map([["ou_zhang", "张三"]]);
    expect(expandCardMentions("请<at id=ou_zhang></at>处理", names)).toBe("请张三(ou_zhang)处理");
    expect(renderCardPeople("已经通知张三(ou_zhang)", [{ openId: "ou_zhang", name: "张三" }]))
      .toBe("已经通知<at id=ou_zhang></at>");
    expect(renderCardPeople("历史里提到@张三(ou_zhang)", [])).toBe("历史里提到<at id=ou_zhang></at>");
    expect(renderCardPeople("历史里提到张三(ou_zhang)", [])).toBe("历史里提到张三");
  });

  it("普通文本和 CardKit 分别使用各自的提及格式，界面不显示 open_id", () => {
    const people = [{ openId: "ou_zhang", name: "张三" }];
    expect(renderTextPeople("已通知张三(ou_zhang)", people))
      .toBe('已通知<at user_id="ou_zhang">张三</at>');
    expect(renderTextPeople("已通知@李四(ou_li)", []))
      .toBe('已通知<at user_id="ou_li">李四</at>');
    expect(renderCardPeople('已通知<at user_id="ou_zhang">张三</at>', people))
      .toBe("已通知<at id=ou_zhang></at>");
    expect(renderTextPeople("已通知<at id=ou_zhang></at>", people))
      .toBe('已通知<at user_id="ou_zhang">张三</at>');
    expect(renderTextPeople('已通知<at id="ou_zhang"></at>', people))
      .toBe('已通知<at user_id="ou_zhang">张三</at>');
    expect(renderCardPeople("已通知@张三(ou_zha", people))
      .toBe("已通知<at id=ou_zhang></at>");
    expect(renderTextPeople("示例 `<at id=ou_zhang></at>`", people))
      .toBe("示例 `<at id=ou_zhang></at>`");
    expect(renderTextPeople("已通知<at id=ou_li></at>", []))
      .toBe('已通知<at user_id="ou_li">用户</at>');
  });

  it("Card 2.0 消息原文可提取可见文字", () => {
    const content = JSON.stringify({ json_card: JSON.stringify({ schema: "2.0", header: { title: { content: "审批" } }, body: { elements: [{ tag: "markdown", content: "请<at id=ou_zhang></at>确认" }] } }) });
    expect(cardVisibleText(content)).toBe("审批\n请<at id=ou_zhang></at>确认");
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
    const card = JSON.stringify({ schema: "2.0", body: { elements: [{ tag: "markdown", content: "请<at id=ou_zhang></at>确认" }] } });
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { items: [{ body: { content: JSON.stringify({ json_card: card }) }, mentions: [{ id: { open_id: "ou_zhang" }, name: "张三" }] }] } }) }));
    vi.stubGlobal("fetch", fetchMock);
    const read = createHistoryCardReader({ cwd, appId: "cli_test", appSecret: "unused", userToken: "user-token" });
    expect(await read("om_card")).toBe("请张三(ou_zhang)确认");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_card?card_msg_content_type=user_card_content",
      expect.objectContaining({ headers: { Authorization: "Bearer user-token" } }),
    );
  });
});
