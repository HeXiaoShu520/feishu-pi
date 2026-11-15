import { describe, expect, it } from "vitest";
import { extractStickerKey, stripStickerTag, imageMessageText, VISIBLE_IMAGE_MESSAGE, VISIBLE_STICKER_MESSAGE, UNAVAILABLE_STICKER_MESSAGE } from "../src/feishu/sticker-message.ts";

describe("收藏表情消息解析", () => {
  it("从 XML 和 JSON 里取出资源 key", () => {
    expect(extractStickerKey('<sticker key="5057e5dd-9006" />')).toBe("5057e5dd-9006");
    expect(extractStickerKey("", '{"file_key":"img_v3_abc"}')).toBe("img_v3_abc");
    expect(extractStickerKey("", '{"image_key":"img_v3_def"}')).toBe("img_v3_def");
    expect(extractStickerKey("普通文本", "not json")).toBeUndefined();
  });

  it("清掉裸标签，留下可读文本", () => {
    expect(stripStickerTag('<sticker key="abc"/>')).toBe("");
    expect(stripStickerTag('你看 <sticker key="abc"/> 这个')).toBe("你看  这个");
  });

  it("可见图片不强调没文字，也不预先断言一定在斗图", () => {
    expect(imageMessageText("[图片] 已保存到: private/path", "image", true)).toBe(VISIBLE_IMAGE_MESSAGE);
    expect(imageMessageText("分析这个报错\n[图片] 已保存到: private/path", "image", true)).toBe(`分析这个报错\n${VISIBLE_IMAGE_MESSAGE}`);
  });

  it("可见收藏表情保留发言性质，显式问图时保留用户问题", () => {
    expect(imageMessageText('<sticker key="abc"/>', "sticker", true)).toBe(VISIBLE_STICKER_MESSAGE);
    expect(imageMessageText('这张图是什么意思？<sticker key="abc"/>', "sticker", true)).toBe(`这张图是什么意思？\n${VISIBLE_STICKER_MESSAGE}`);
  });

  it("收藏表情明确未知，不能借引用图冒充看到了当前图", () => {
    expect(imageMessageText('<sticker key="abc"/>', "sticker", false)).toBe(UNAVAILABLE_STICKER_MESSAGE);
    expect(imageMessageText("[表情包]", "sticker", false)).toBe(UNAVAILABLE_STICKER_MESSAGE);
  });
});
