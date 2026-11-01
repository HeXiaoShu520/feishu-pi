import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Inspired by Aurabot's decaying mood, without saving the user's messages.
const BASE = 60;
const HALF_LIFE_HOURS = 8;
export function decayedMood(value: number, at: number, now = Date.now()): number {
  return BASE + (value - BASE) * Math.pow(0.5, Math.max(0, now - at) / 3_600_000 / HALF_LIFE_HOURS);
}

export function moodDelta(text: string): number {
  // Only unambiguous phrases addressed to the companion; do not score a user's
  // own bad day or isolated words like “难过”, “傻”, or “喜欢”.
  const positive = ["喜欢你", "谢谢你", "辛苦你", "你真棒", "你好可爱", "给你抱抱"];
  const negative = ["讨厌你", "你给我闭嘴", "你真没用", "你给我滚"];
  const score = positive.filter(word => text.includes(word) && !text.includes(`不${word}`) && !text.includes(`没${word}`)).length * 6 - negative.filter(word => text.includes(word) && !text.includes(`不${word}`)).length * 8;
  return Math.max(-16, Math.min(16, score));
}

export class CompanionMood {
  private pending: Promise<void> = Promise.resolve();
  private readonly file: string;
  constructor(file: string) { this.file = file; }

  async observe(text: string, now = Date.now()): Promise<string> {
    let context = "";
    const task = this.pending.then(async () => {
      let state = { value: BASE, at: now };
      try {
        const parsed = JSON.parse(await readFile(this.file, "utf8")) as { value?: unknown; at?: unknown };
        if (typeof parsed.value === "number" && Number.isFinite(parsed.value) && typeof parsed.at === "number" && Number.isFinite(parsed.at)) {
          state = { value: Math.max(0, Math.min(100, parsed.value)), at: parsed.at };
        }
      } catch { /* Missing or invalid state starts at the baseline. */ }
      const value = Math.max(0, Math.min(100, decayedMood(state.value, state.at, now) + moodDelta(text)));
      if (value >= 70) context = "当前角色心情比较轻快，可以自然活泼一点；仍以理解和帮助用户为先。";
      else if (value < 45) context = "当前角色心情稍微低落，表达可以平静一点；不要冷落、责怪或让用户安慰你。";
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ value, at: now }), "utf8");
      await rename(temporary, this.file);
    });
    this.pending = task.catch(() => {});
    await task;
    return context;
  }
}
