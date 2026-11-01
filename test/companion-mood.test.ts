import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanionMood, decayedMood, moodDelta } from "../src/assistant/companion-mood.ts";

describe("companion mood", () => {
  it("returns to baseline over time and does not treat the user's sadness as an insult", () => {
    expect(decayedMood(80, 0, 8 * 3_600_000)).toBe(70);
    expect(moodDelta("我今天很难过，工作太烦了")).toBe(0);
    expect(moodDelta("谢谢你，你真棒")).toBe(12);
  });
  it("persists only mood state and restores it after restarting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "companion-mood-"));
    try {
      const file = join(dir, "mood.json");
      await new CompanionMood(file).observe("谢谢你，你真棒", 1000);
      expect(await new CompanionMood(file).observe("你好", 1000)).toContain("轻快");
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ value: 72, at: 1000 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
