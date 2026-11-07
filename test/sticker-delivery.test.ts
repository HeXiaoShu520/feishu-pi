import { describe, expect, it, vi } from "vitest";
import { StickerDelivery } from "../src/stickers/delivery.ts";
import { mapPiEvent } from "../src/runtime/feishu-pi-runtime.ts";

const markdown = "![鱼](img_1)";
function observe(delivery: StickerDelivery, value: object, isError = false) {
  const event = mapPiEvent({ type: "tool_execution_end", toolName: "sticker_send", isError,
    result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
  if (event) delivery.observe(event);
}
const uploaded = { id: "fish:1", line: "开心", status: "uploaded_pending_card", imageKey: "img_1", markdown };

describe("表情发送记录闭环", () => {
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
