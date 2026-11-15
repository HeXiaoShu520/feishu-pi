import { describe, expect, it } from "vitest";
import { ConversationPresence } from "../src/conversation/presence.ts";

describe("实际发送后的连续性", () => {
  it("分会话保存最近回复和时间，不虚构后台经历", () => {
    let now = 1_000;
    const presence = new ConversationPresence(() => now);
    presence.delivered("a", "刚才那张不服", false);
    now += 5_000;
    expect(presence.recall("a")).toContain('"secondsSinceLastReply":5');
    expect(presence.recall("a")).toContain('"localTime":');
    expect(presence.recall("a")).toContain(`"timeZone":"${Intl.DateTimeFormat().resolvedOptions().timeZone}"`);
    expect(presence.recall("a")).toContain("刚才那张不服");
    expect(presence.recall("b")).not.toContain("刚才那张不服");
    presence.clear("a");
    expect(presence.recall("a")).not.toContain("刚才那张不服");
  });
  it("最多保留三条，图片回复不冒充文字", () => {
    const presence = new ConversationPresence(() => 1_000);
    for (let i = 0; i < 4; i++) presence.delivered("a", `消息${i}`, false);
    expect(presence.recall("a")).not.toContain("消息0");
    presence.delivered("a", "", true);
    expect(presence.recall("a")).toContain("已发送一张表情图片");
  });
});
