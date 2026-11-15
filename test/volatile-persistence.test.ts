import { describe, expect, it } from "vitest";
import { stripVolatileContent } from "../src/runtime/feishu-pi-runtime.ts";

/** 易失内容不落盘：写入会话 jsonl 前剔除思考；image 块必须保留——Pi 1.5.0 请求走落盘投影，写盘剥图当轮到不了模型 */
describe("stripVolatileContent（易失内容不落盘）", () => {
  it("剔除 thinking 块", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "内部推理内容", thinkingSignature: "reasoning_content" },
        { type: "text", text: "最终答复" },
      ],
    };
    const out = stripVolatileContent(message) as { content: Array<{ type: string }> };
    expect(out.content).toHaveLength(1);
    expect(out.content[0]).toEqual({ type: "text", text: "最终答复" });
  });

  it("image 块原样保留（Pi 1.5.0 请求走落盘投影，写盘剥图当轮就到不了模型）", () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "看看这张图" },
        { type: "image", data: "A".repeat(400_000), mimeType: "image/jpeg" },
      ],
    };
    const out = stripVolatileContent(message) as { content: Array<{ type: string; mimeType?: string; data?: string }> };
    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    // base64 完整落盘（体积代价已知：单张数百 KB；work_space 不入库，data-cleaner 管保留期）
    expect(out.content[1].data).toBe("A".repeat(400_000));
  });

  it("toolResult 里的图片同样保留（消息 content 统一处理）", () => {
    const message = {
      role: "toolResult",
      toolName: "screenshot",
      content: [{ type: "image", data: "B".repeat(1000), mimeType: "image/png" }],
    };
    const out = stripVolatileContent(message) as { content: Array<{ type: string }> };
    expect(out.content).toHaveLength(1);
    expect(out.content[0].type).toBe("image");
  });

  it("删除顶层的 reasoning_content / reasoningContent 字段", () => {
    const out = stripVolatileContent({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      reasoning_content: "x",
      reasoningContent: "y",
    }) as Record<string, unknown>;
    expect("reasoning_content" in out).toBe(false);
    expect("reasoningContent" in out).toBe(false);
  });

  it("普通文本消息原样保留，且不修改入参（深拷贝）", () => {
    const message = { role: "user", content: [{ type: "text", text: "问题" }] };
    const out = stripVolatileContent(message);
    expect(out).toEqual(message);
    expect(out).not.toBe(message);
  });

  it("null / undefined 安全返回", () => {
    expect(stripVolatileContent(null)).toBeNull();
    expect(stripVolatileContent(undefined)).toBeUndefined();
  });
});
