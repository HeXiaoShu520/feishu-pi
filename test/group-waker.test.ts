import { describe, expect, it } from "vitest";
import { GroupWaker } from "../src/feishu/group-waker.ts";

const at = (hour: number, minute = 0) => new Date(2026, 0, 1, hour, minute).getTime();

describe("群聊唤醒判定", () => {
  it("被叫名字必醒，重复点名一分钟内只接一次", () => {
    let now = at(14);
    const waker = new GroupWaker({ random: () => 0.99, now: () => now });
    expect(waker.decide({ chatId: "g1", text: "大肥鱼在吗" }).wake).toBe(true);
    expect(waker.decide({ chatId: "g1", text: "大肥鱼大肥鱼" }).wake).toBe(false);
    now += 61_000;
    expect(waker.decide({ chatId: "g1", text: "肥鱼出来" }).wake).toBe(true);
  });

  it("深夜不主动接话，点名仍然回应", () => {
    const waker = new GroupWaker({ random: () => 0, now: () => at(3) });
    expect(waker.decide({ chatId: "g1", text: "随便聊聊" }).wake).toBe(false);
    expect(waker.decide({ chatId: "g1", text: "大肥鱼" }).wake).toBe(true);
  });

  it("普通消息按概率接话，接完进入冷却", () => {
    let now = at(14);
    const waker = new GroupWaker({ random: () => 0, now: () => now });
    expect(waker.decide({ chatId: "g1", text: "今天天气不错" }).wake).toBe(true);
    expect(waker.decide({ chatId: "g1", text: "今天天气不错" }).wake).toBe(false);
    now += 11 * 60_000;
    expect(waker.decide({ chatId: "g1", text: "今天天气不错" }).wake).toBe(true);
  });

  it("图片比普通消息更容易被接", () => {
    let now = at(14);
    const waker = new GroupWaker({ random: () => 0.1, now: () => now });
    expect(waker.decide({ chatId: "g1", text: "", hasImage: true }).wake).toBe(true);
    now += 11 * 60_000;
    expect(waker.decide({ chatId: "g1", text: "纯文字" }).wake).toBe(false);
  });

  it("每个群每小时最多主动接三次", () => {
    let now = at(14);
    const waker = new GroupWaker({ random: () => 0, now: () => now, cooldownMs: 0, hourlyLimit: 3 });
    expect(waker.decide({ chatId: "g1", text: "一" }).wake).toBe(true);
    expect(waker.decide({ chatId: "g1", text: "二" }).wake).toBe(true);
    expect(waker.decide({ chatId: "g1", text: "三" }).wake).toBe(true);
    expect(waker.decide({ chatId: "g1", text: "四" }).wake).toBe(false);
    expect(waker.decide({ chatId: "g2", text: "另一个群" }).wake).toBe(true);
    now += 60 * 60_000;
    expect(waker.decide({ chatId: "g1", text: "下一小时" }).wake).toBe(true);
  });

  it("关闭后完全潜水", () => {
    const waker = new GroupWaker({ enabled: false, random: () => 0 });
    expect(waker.decide({ chatId: "g1", text: "大肥鱼" }).wake).toBe(false);
  });
});
