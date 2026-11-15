import { describe, expect, it, vi } from "vitest";
import { StickerDelivery, isStickerCommentary, stripStickerCommentary } from "../src/stickers/delivery.ts";
import { mapPiEvent } from "../src/runtime/feishu-pi-runtime.ts";

const markdown = "![鱼](img_1)";
function observe(delivery: StickerDelivery, value: object, isError = false) {
  const event = mapPiEvent({ type: "tool_execution_end", toolName: "sticker_send", isError,
    result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
  if (event) delivery.observe(event);
}
const uploaded = { id: "fish:1", line: "开心", status: "uploaded_pending_card", imageKey: "img_1", markdown };

describe("表情发送记录闭环", () => {
  it("解说过滤不误删正常讨论，也不吞掉后面的真实回答", () => {
    expect(stripStickerCommentary("这张图也太好笑了")).toBe("这张图也太好笑了");
    expect(stripStickerCommentary("一个是网络问题，另一个是权限问题。")).toBe("一个是网络问题，另一个是权限问题。");
    expect(stripStickerCommentary("库存不足，需要补货。")).toBe("库存不足，需要补货。");
    expect(stripStickerCommentary("先甩两张给你。比赛三点开始。")).toBe("比赛三点开始。");
    expect(stripStickerCommentary("不吭声只丢图，我这边就剩一个问号了。反弹！")).toBe("反弹！");
    const code = "```text\n先甩两张给你。\n```";
    expect(stripStickerCommentary(code)).toBe(code);
  });
  it("发图后不再催用户说文字，正常接招仍保留", () => {
    expect(isStickerCommentary("不吭声只丢图，我这边就剩一个问号了。")).toBe(true);
    expect(isStickerCommentary("图我收下了，就是看了三张还是没听见你说一句话。")).toBe(true);
    expect(isStickerCommentary("反弹，轮到你接了")).toBe(false);
    expect(isStickerCommentary("就这点攻击力？")).toBe(false);
  });
  it("仅记录本轮实际贴出的图片，确认两次也只记录一次", async () => {
    const delivery = new StickerDelivery(), record = vi.fn(async () => {});
    observe(delivery, uploaded);
    await delivery.confirm("没贴图片", record);
    expect(record).not.toHaveBeenCalled();
    await delivery.confirm(markdown, record);
    await delivery.confirm(markdown, record);
    expect(record).toHaveBeenCalledExactlyOnceWith("fish:1", "开心");
  });
  it("轮次隔离，代码片段和失败结果不记为发图", async () => {
    const first = new StickerDelivery(), second = new StickerDelivery(), record = vi.fn(async () => {});
    observe(first, uploaded);
    observe(second, uploaded, true);
    await second.confirm(markdown, record);
    await first.confirm(`\`\`\`md\n${markdown}\n\`\`\``, record);
    await first.confirm(`\`${markdown}\``, record);
    expect(record).not.toHaveBeenCalled();
  });
  it("独立图片只有成功结果且存在消息 ID 才算已发送", () => {
    const delivery = new StickerDelivery();
    observe(delivery, { id: "fish:1", sent: true });
    observe(delivery, { id: "fish:1", sent: true, messageId: "om_1" }, true);
    expect(delivery.standaloneSent).toBe(false);
    observe(delivery, { id: "fish:1", sent: true, messageId: "om_1" });
    expect(delivery.standaloneSent).toBe(true);
  });
});
