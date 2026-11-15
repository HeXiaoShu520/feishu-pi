import { describe, expect, it, vi } from "vitest";
import { cleanProactiveText, ProactiveService, type ProactiveSnapshot } from "../src/proactive/service.ts";

const at = (hour: number) => new Date(2026, 0, 1, hour, 0).getTime();

function setup(options: { now: number; generate?: () => Promise<string>; idleMs?: number }) {
  let now = options.now;
  const snapshot: ProactiveSnapshot = {
    chatId: "g1",
    lastAt: now - 60 * 60_000,
    messages: [{ name: "哥哥", text: "今天累死了", at: now - 60 * 60_000 }],
  };
  const deps = {
    recent: vi.fn((_chatId: string) => snapshot),
    generate: vi.fn(options.generate ?? (async () => "那就躺会儿，别硬撑")),
    send: vi.fn(async () => undefined),
    recordSelf: vi.fn(),
  };
  const service = new ProactiveService({
    chats: ["g1"],
    idleMs: options.idleMs ?? 45 * 60_000,
    cooldownMs: 3 * 60 * 60_000,
    dailyLimit: 2,
    chance: 1,
    now: () => now,
    random: () => 0,
  }, deps);
  return { service, deps, snapshot, advance: (ms: number) => { now += ms; } };
}

describe("群聊主动发言", () => {
  it("群安静够久时生成一句并发送", async () => {
    const { service, deps } = setup({ now: at(14) });
    expect(await service.checkNow()).toEqual(["g1"]);
    expect(deps.generate).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledWith("g1", "那就躺会儿，别硬撑");
    expect(deps.recordSelf).toHaveBeenCalled();
  });

  it("群刚活动过不发言", async () => {
    const { service, deps } = setup({ now: at(14), idleMs: 45 * 60_000 });
    deps.recent.mockReturnValue({ chatId: "g1", lastAt: at(14), messages: [{ name: "A", text: "刚说话", at: at(14) }] });
    expect(await service.checkNow()).toEqual([]);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("深夜不发言", async () => {
    const { service, deps } = setup({ now: at(3) });
    expect(await service.checkNow()).toEqual([]);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("模型判断 SKIP 时不发送", async () => {
    const { service, deps } = setup({ now: at(14), generate: async () => "[SKIP]" });
    expect(await service.checkNow()).toEqual([]);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("生成太长或发送失败都不算一次发言", async () => {
    const long = setup({ now: at(14), generate: async () => "啊".repeat(200) });
    expect(await long.service.checkNow()).toEqual([]);
    expect(long.deps.send).not.toHaveBeenCalled();

    const failing = setup({ now: at(14) });
    failing.deps.send.mockRejectedValue(new Error("network"));
    expect(await failing.service.checkNow()).toEqual([]);
  });

  it("冷却和每日上限都会限制发言", async () => {
    const { service, deps, snapshot, advance } = setup({ now: at(14) });
    expect(await service.checkNow()).toEqual(["g1"]);
    expect(await service.checkNow()).toEqual([]);

    advance(4 * 60 * 60_000);
    snapshot.lastAt += 4 * 60 * 60_000;
    expect(await service.checkNow()).toEqual(["g1"]);
    advance(4 * 60 * 60_000);
    snapshot.lastAt += 4 * 60 * 60_000;
    expect(await service.checkNow()).toEqual([]);
    expect(deps.send).toHaveBeenCalledTimes(2);
  });

  it("清理模型带出来的前缀和引号", () => {
    expect(cleanProactiveText("大肥鱼： “那就这样吧”")).toBe("那就这样吧");
  });

  it("话题过时或者最后一句是自己说的就不自说自话", async () => {
    const old = setup({ now: at(14) });
    old.snapshot.lastAt -= 4 * 60 * 60_000;
    expect(await old.service.checkNow()).toEqual([]);
    expect(old.deps.generate).not.toHaveBeenCalled();
    const self = setup({ now: at(14) });
    self.snapshot.messages[0].self = true;
    expect(await self.service.checkNow()).toEqual([]);
    expect(self.deps.generate).not.toHaveBeenCalled();
  });

  it("生成期间有新消息时丢弃旧话题的回复", async () => {
    const { service, deps, snapshot } = setup({ now: at(14) });
    deps.generate.mockImplementation(async () => {
      snapshot.lastAt += 1000;
      snapshot.messages.push({ name: "A", text: "换个话题", at: snapshot.lastAt });
      return "还在接旧话";
    });
    expect(await service.checkNow()).toEqual([]);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("生成期间话题过期后不再发送", async () => {
    const { service, deps, advance } = setup({ now: at(14) });
    deps.generate.mockImplementation(async () => {
      advance(3 * 60 * 60_000);
      return "迟来的回复";
    });
    expect(await service.checkNow()).toEqual([]);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("服务关闭后，未完成的生成结果不能再发出", async () => {
    const { service, deps } = setup({ now: at(14) });
    deps.generate.mockImplementation(async () => {
      service.close();
      return "不该在关闭后发出";
    });
    expect(await service.checkNow()).toEqual([]);
    expect(await service.checkNow()).toEqual([]);
    expect(deps.send).not.toHaveBeenCalled();
  });
});
