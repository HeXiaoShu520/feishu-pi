import { describe, expect, it } from "vitest";
import { mapPiEvent, type PiRawEvent } from "../src/runtime/feishu-pi-runtime.ts";

function assistantMessage(text: string): PiRawEvent {
  return {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

describe("mapPiEvent（pi 事件 → 桥接事件）", () => {
  it("流式增量 message_update → assistant_text（原行为保持）", () => {
    expect(mapPiEvent(assistantMessage("你好"))).toEqual({ type: "assistant_text", text: "你好" });
  });

  it("一次性返回：pi 只发 message_start + message_end（无 update）→ 同样映射为 assistant_text", () => {
    const start: PiRawEvent = { ...assistantMessage("完整答复"), type: "message_start" };
    const end: PiRawEvent = { ...assistantMessage("完整答复"), type: "message_end" };
    expect(mapPiEvent(start)).toEqual({ type: "assistant_text", text: "完整答复" });
    expect(mapPiEvent(end)).toEqual({ type: "assistant_text", text: "完整答复" });
  });

  it("message_start 的空 partial（无文本内容）→ 不产生事件", () => {
    const empty: PiRawEvent = {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "..." } as never] },
    };
    expect(mapPiEvent(empty)).toBeUndefined();
    expect(mapPiEvent({ type: "message_end", message: { role: "assistant", content: [] } })).toBeUndefined();
  });

  it("用户消息的 message_start/end 不映射为 assistant_text", () => {
    expect(mapPiEvent({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "问题" }] } })).toBeUndefined();
  });

  it("工具事件映射保持：start/update/end", () => {
    expect(mapPiEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } }))
      .toEqual({ type: "tool_started", toolName: "bash", args: { command: "ls" } });
    expect(mapPiEvent({ type: "tool_execution_update", toolName: "bash" }))
      .toEqual({ type: "tool_updated", toolName: "bash" });
    expect(mapPiEvent({ type: "tool_execution_end", toolName: "bash", isError: true }))
      .toEqual({ type: "tool_finished", toolName: "bash", isError: true });
  });

  it("其他事件（agent_start 等）→ undefined", () => {
    expect(mapPiEvent({ type: "agent_start" } as PiRawEvent)).toBeUndefined();
  });
});
