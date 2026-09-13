import { describe, expect, it } from "vitest";
import { AskBroker, buildChoiceCard, createAskUserTool } from "../src/feishu/ask-broker.ts";

/** 测试桩：记录发卡/更新；从发送的卡片里提取首个按钮回调值（qid/token/choice） */
function makeBroker(opts: { sendCardFails?: boolean; askTimeoutMs?: number } = {}) {
  const updates: Array<{ messageId: string; card: object }> = [];
  let sent: { chatId: string; card: object } | undefined;
  const broker = new AskBroker({
    sendCard: async (chatId, card) => {
      if (opts.sendCardFails) return undefined as never;
      sent = { chatId, card };
      return "m-1";
    },
    updateCard: async (messageId, card) => {
      updates.push({ messageId, card });
    },
    askTimeoutMs: opts.askTimeoutMs ?? 5_000,
  });
  const firstCallbackValue = (): Record<string, unknown> => {
    const card = sent!.card as { body: { elements: Array<{ columns?: Array<{ elements: Array<{ behaviors: Array<{ value: Record<string, unknown> }> }> }> }> } };
    const row = card.body.elements.find((e) => "columns" in e)!;
    return row.columns![0].elements[0].behaviors[0].value;
  };
  return { broker, updates, getSent: () => sent, firstCallbackValue };
}

/** 取卡片 body 元素里的 markdown 文本集合 */
function cardTexts(card: object): string[] {
  const body = (card as { body?: { elements?: Array<{ content?: string }> } }).body;
  return (body?.elements ?? []).map((e) => e.content ?? "");
}

describe("AskBroker 提问与结算", () => {
  it("ask 向会话发提问卡并等待；本人点选 → answered，卡片更新为结果", async () => {
    const { broker, updates, getSent, firstCallbackValue } = makeBroker();
    const pending = broker.ask("ou_u", "oc_c", "选一个", ["方案A", "方案B"]);

    expect(getSent()?.chatId).toBe("oc_c");
    const value = firstCallbackValue();
    expect(value.action).toBe("ask_user");

    const outcome = broker.resolve({
      qid: String(value.qid),
      token: String(value.token),
      choice: "方案B",
      operatorOpenId: "ou_u",
      messageId: "m-1",
    });
    expect(outcome).toEqual({ status: "answered", choice: "方案B" });
    expect((await pending).status).toBe("answered");
    expect(updates.some((u) => cardTexts(u.card).some((t) => t.includes("已选择：方案B")))).toBe(true);
  });

  it("非本人点击被忽略（不消耗请求）；之后本人仍可正常作答", async () => {
    const { broker, firstCallbackValue } = makeBroker();
    const pending = broker.ask("ou_u", "oc_c", "选一个", ["A", "B"]);
    const value = firstCallbackValue();

    expect(
      broker.resolve({ qid: String(value.qid), token: String(value.token), choice: "A", operatorOpenId: "ou_other", messageId: "m-1" }),
    ).toBeUndefined();

    const outcome = broker.resolve({ qid: String(value.qid), token: String(value.token), choice: "B", operatorOpenId: "ou_u", messageId: "m-1" });
    expect(outcome).toEqual({ status: "answered", choice: "B" });
    expect((await pending).choice).toBe("B");
  });

  it("token 不匹配 → 忽略", async () => {
    const { broker, firstCallbackValue } = makeBroker();
    const pending = broker.ask("ou_u", "oc_c", "q", ["A", "B"]);
    const value = firstCallbackValue();
    expect(
      broker.resolve({ qid: String(value.qid), token: "bad", choice: "A", operatorOpenId: "ou_u", messageId: "m-1" }),
    ).toBeUndefined();
    void pending;
  });

  it("超时 → timeout，卡片更新为超时提示", async () => {
    const { broker, updates } = makeBroker({ askTimeoutMs: 20 });
    const outcome = await broker.ask("ou_u", "oc_c", "q", ["A", "B"]);
    expect(outcome.status).toBe("timeout");
    expect(updates.some((u) => cardTexts(u.card).some((t) => t.includes("超时")))).toBe(true);
  });

  it("发送卡片失败 → cancelled，不进入等待", async () => {
    const { broker } = makeBroker({ sendCardFails: true });
    const outcome = await broker.ask("ou_u", "oc_c", "q", ["A", "B"]);
    expect(outcome.status).toBe("cancelled");
  });
});

describe("选项卡构建", () => {
  it("每行最多 5 个按钮，7 个选项拆两行，首个按钮 primary", () => {
    const card = buildChoiceCard({ question: "怎么走", options: ["1", "2", "3", "4", "5", "6", "7"], qid: "q1", token: "t1" }) as {
      body: { elements: Array<{ tag: string; columns?: Array<{ elements: Array<{ tag: string; type: string; text: { content: string } }> }> }> };
    };
    const rows = card.body.elements.filter((e) => e.tag === "column_set");
    expect(rows.length).toBe(2);
    expect(rows[0].columns!.length).toBe(5);
    expect(rows[1].columns!.length).toBe(2);
    expect(rows[0].columns![0].elements[0].type).toBe("primary");
    expect(rows[0].columns![1].elements[0].type).toBe("default");
  });

  it("超长选项截断到 30 字符加省略号", () => {
    const long = "一".repeat(40);
    const card = buildChoiceCard({ question: "q", options: [long, "B"], qid: "q1", token: "t1" }) as {
      body: { elements: Array<{ columns?: Array<{ elements: Array<{ text: { content: string } }> }> }> };
    };
    const first = card.body.elements.find((e) => "columns" in e)!.columns![0].elements[0].text.content;
    expect(first.length).toBe(31);
    expect(first.endsWith("…")).toBe(true);
  });
});

describe("ask_user_question 工具", () => {
  it("把所选选项原文返回给模型；_caller 决定提问对象与会话", async () => {
    const { broker, getSent, firstCallbackValue } = makeBroker();
    const tool = createAskUserTool(broker);
    const resultPromise = tool.execute("tc1", {
      question: "用哪个方案",
      options: ["方案A", "方案B"],
      _caller: { openId: "ou_u", chatId: "oc_c" },
    } as never);

    expect(getSent()?.chatId).toBe("oc_c");
    const value = firstCallbackValue();
    broker.resolve({
      qid: String(value.qid),
      token: String(value.token),
      choice: "方案A",
      operatorOpenId: "ou_u",
      messageId: "m-1",
    });

    const result = await resultPromise;
    expect(result.content[0]).toEqual({ type: "text", text: "用户选择了：方案A" });
  });

  it("参数不完整（少于 2 个选项）→ 报错文本，不发卡", async () => {
    const { broker, getSent } = makeBroker();
    const tool = createAskUserTool(broker);
    const result = await tool.execute("tc1", { question: "q", options: ["只有"], _caller: { openId: "ou_u", chatId: "oc_c" } } as never);
    expect(String((result.content[0] as { text?: string }).text)).toContain("参数不完整");
    expect(getSent()).toBeUndefined();
  });

  it("超时 → 返回重问提示文本", async () => {
    const { broker } = makeBroker({ askTimeoutMs: 20 });
    const tool = createAskUserTool(broker);
    const result = await tool.execute("tc1", { question: "q", options: ["A", "B"], _caller: { openId: "ou_u", chatId: "oc_c" } } as never);
    expect(String((result.content[0] as { text?: string }).text)).toContain("超时");
  });
});
