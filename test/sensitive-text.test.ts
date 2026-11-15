import { describe, expect, it } from "vitest";
import { containsSensitiveText } from "../src/assistant/sensitive.ts";

describe("敏感内容过滤", () => {
  it("识别常见凭证与配置的真实密钥", () => {
    expect(containsSensitiveText("我的密码是 123456")).toBe(true);
    expect(containsSensitiveText("Bearer abcdefg")).toBe(true);
    expect(containsSensitiveText("今天天气不错")).toBe(false);
  });

  it("环境变量里的真实密钥也会命中", () => {
    const previous = process.env.FEISHU_GUARD_API_KEY;
    process.env.FEISHU_GUARD_API_KEY = "guard-secret-value";
    try {
      expect(containsSensitiveText("值是 guard-secret-value")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.FEISHU_GUARD_API_KEY;
      else process.env.FEISHU_GUARD_API_KEY = previous;
    }
  });
});
