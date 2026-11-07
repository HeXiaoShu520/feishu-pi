import { describe, expect, it } from "vitest";
import { historyTimeWindow } from "../src/assistant/memory-query.ts";

describe("历史对话时间范围", () => {
  it("按北京时间解析跨年的上个月和指定月份", () => {
    const now = Date.parse("2027-01-01T01:00:00Z");
    expect(historyTimeWindow("上个月我们聊过的鲸鱼", now)).toEqual({ start: Date.parse("2026-11-30T16:00:00Z"), end: Date.parse("2026-12-31T16:00:00Z") });
    expect(historyTimeWindow("2026年2月", now)).toEqual({ start: Date.parse("2026-01-31T16:00:00Z"), end: Date.parse("2026-02-28T16:00:00Z") });
    expect(historyTimeWindow("2026年13月", now)).toBeUndefined();
  });
});
