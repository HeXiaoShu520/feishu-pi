import { describe, expect, it } from "vitest";
import { IMAGE_OMITTED_PLACEHOLDER, stripVolatileContent } from "../src/runtime/feishu-pi-runtime.ts";

/** 易失内容不落盘：写入会话 jsonl 前剔除思考与图片 base64（内存中的上下文不受影响） */
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

  it("image 块换成占位文本，且不再含 base64", () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "看看这张图" },
        { type: "image", data: "A".repeat(400_000), mimeType: "image/jpeg" },
      ],
    };
    const out = stripVolatileContent(message) as { content: Array<{ type: string; text?: string }> };
    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toEqual({ type: "text", text: IMAGE_OMITTED_PLACEHOLDER });
    // 关键：体积塌陷（40 万字符的 base64 不再落盘）
    expect(JSON.stringify(out).length).toBeLessThan(2000);
  });

  it("toolResult 里的图片同样被剔除（消息 content 统一处理）", () => {
    const message = {
      role: "toolResult",
      toolName: "screenshot",
      content: [{ type: "image", data: "B".repeat(1000), mimeType: "image/png" }],
    };
    const out = stripVolatileContent(message) as { content: Array<{ type: string; text?: string }> };
    expect(out.content[0].type).toBe("text");
    expect(out.content[0].text).toBe(IMAGE_OMITTED_PLACEHOLDER);
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
