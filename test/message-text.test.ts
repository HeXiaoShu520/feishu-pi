import { describe, expect, it } from "vitest";
import { findBlockBoundary } from "../src/feishu/cardkit-reply.ts";
import { stripBotMentions } from "../src/feishu/lark-transport.ts";

describe("stripBotMentions（@机器人 标记清洗）", () => {
  const BOT = "ou_bot123";

  it("清除 <at> 标记与 @占位 并 trim", () => {
    expect(stripBotMentions(`<at user_id="${BOT}"></at> 你好`, BOT)).toBe("你好");
    expect(stripBotMentions(`@${BOT} 帮我看看`, BOT)).toBe("帮我看看");
    expect(stripBotMentions(`<at user_id="${BOT}">机器人</at> 问题 <at user_id="ou_other">别人</at>`, BOT))
      .toBe("问题 <at user_id=\"ou_other\">别人</at>");
  });

  it("无 botOpenId 时仅 trim；普通文本原样", () => {
    expect(stripBotMentions("  原样文本  ", undefined)).toBe("原样文本");
    expect(stripBotMentions("  普通问题  ", BOT)).toBe("普通问题");
  });
});

describe("findBlockBoundary（分卡安全边界）", () => {
  it("返回最后一个不在代码围栏内的空行边界", () => {
    const text = "第一段\n\n第二段\n\n```js\ncode\n\nstill code\n```\n\n结尾";
    // 最后一个安全边界：代码围栏结束之后的那个空行
    const split = findBlockBoundary(text);
    expect(text.slice(split)).toBe("结尾");
  });

  it("边界落在代码块内时向前回退到围栏外的边界", () => {
    const text = "前文\n\n```js\na\n\nb\n```";
    const split = findBlockBoundary(text);
    expect(text.slice(split)).toBe("```js\na\n\nb\n```");
  });

  it("找不到安全边界返回 -1", () => {
    expect(findBlockBoundary("只有一段没有空行")).toBe(-1);
    expect(findBlockBoundary("```js\n\n\n```")).toBe(-1); // 唯一空行都在围栏内
  });
});

