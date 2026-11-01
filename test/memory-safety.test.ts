import { describe, expect, it } from "vitest";
import { containsSensitiveText, safeMemoryHistory } from "../src/assistant/memory-safety.ts";

describe("提炼记忆时过滤敏感对话", () => {
  it("整轮过滤含敏感词的用户消息和回显，不影响其他轮次", () => {
    expect(safeMemoryHistory([
      { role: "user", content: "我的密码是可乐" },
      { role: "assistant", content: "你说的是可乐" },
      { role: "user", content: "我喜欢草莓" },
      { role: "assistant", content: "记住啦" },
    ]).map(item => item.content)).toEqual(["我喜欢草莓", "记住啦"]);
  });
  it("识别已配置的密钥原文", () => {
    const old = process.env.FEISHU_GUARD_API_KEY;
    try {
      process.env.FEISHU_GUARD_API_KEY = "fake-sensitive-1234";
      expect(containsSensitiveText("fake-sensitive-1234")).toBe(true);
    } finally {
      if (old === undefined) delete process.env.FEISHU_GUARD_API_KEY; else process.env.FEISHU_GUARD_API_KEY = old;
    }
  });
});
