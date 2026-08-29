import { describe, expect, it } from "vitest";
import type { FeishuPiEvent } from "../src/runtime/types.ts";

describe("FeishuPiEvent", () => {
  it("supports tool lifecycle events without assistant text", () => {
    const events: FeishuPiEvent[] = [
      { type: "tool_started", toolName: "read" },
      { type: "tool_updated", toolName: "read" },
      { type: "tool_finished", toolName: "read", isError: false },
    ];
    expect(events.map((event) => event.type)).toEqual(["tool_started", "tool_updated", "tool_finished"]);
  });
});
