import { describe, expect, it, vi } from "vitest";
import { extractEmojiNames, loadFeishuEmojiImages, resolveEmojiImage } from "../src/feishu/emoji-images.ts";

describe("飞书原生表情图片", () => {
  it("中文名能对上官方 emoji_type 和图片", () => {
    expect(resolveEmojiImage("看")?.type).toBe("GLANCE");
    expect(resolveEmojiImage("黑线")?.type).toBe("DULL");
    expect(resolveEmojiImage("尬笑")?.type).toBe("SWEAT");
    expect(resolveEmojiImage("不存在的表情")).toBeUndefined();
  });

  it("从正文里取出已知表情并去重", () => {
    expect(extractEmojiNames("[看] 你说的[黑线][看][图片]")).toEqual(["看", "黑线"]);
  });

  it("按上限加载图片，失败不影响其他项", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("emoji_dull")) throw new Error("boom");
      return {
        ok: true,
        arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
      } as unknown as Response;
    });
    const images = await loadFeishuEmojiImages(["看", "黑线", "尬笑", "赞"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      limit: 3,
    });
    expect(images.map((image) => image.name)).toEqual(["看", "尬笑"]);
    expect(images[0].mimeType).toBe("image/png");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
