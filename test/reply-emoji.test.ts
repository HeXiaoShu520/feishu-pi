import { describe, expect, it } from "vitest";
import { stripEmoji } from "../src/utils/emoji.ts";

describe("stripEmoji（关闭回复 emoji 时的发送前兜底）", () => {
  it("删除正文里的 emoji，保留文字与标点", () => {
    expect(stripEmoji("哟，哥哥这是笑什么呢？😏 想接着斗图吗 😅")).toBe("哟，哥哥这是笑什么呢？想接着斗图吗");
  });

  it("组合 emoji（变体符 / ZWJ 序列）不残留", () => {
    expect(stripEmoji("❤️ 👨‍👩‍👧 ✅")).toBe("");
  });

  it("代码块内的内容原样保留（代码语义优先）", () => {
    const text = "看这行 🔥\n```bash\necho 😏\n```\n完事 😅";
    expect(stripEmoji(text)).toBe("看这行\n```bash\necho 😏\n```\n完事");
  });

  it("清理删除后的多余空白与行尾空格", () => {
    expect(stripEmoji("第一行 😏")).toBe("第一行");
    expect(stripEmoji("😏 开头")).toBe("开头");
    expect(stripEmoji("a 😏😏 b")).toBe("a b");
  });

  it("没有 emoji 的文本原样返回", () => {
    const text = "正常的中文回复，含标点。";
    expect(stripEmoji(text)).toBe(text);
  });
});
