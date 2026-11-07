import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BiliAutomation, type BiliAutomationDependencies } from "../src/bilibili/automation.ts";
import { parseBiliDecision } from "../src/bilibili/decision.ts";
import { BiliAutoCommand } from "../src/feishu/bili-auto-command.ts";

const NOW = Date.parse("2026-10-31T12:00:00Z");
function setup(dir: string) {
  const authorize = vi.fn().mockResolvedValue(undefined);
  const call = vi.fn(async (name: string, _args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (name === "bili_check_replies") return { replies: [{ actionable: true, already_replied: false, bvid: "BV1234567890", parent_rpid: "22", root_rpid: "11", uid: "123", text: "你好" }] };
    if (name === "bili_explore") return { videos: [{ bvid: "BVabcdefghij", read: { info: { title: "鲸鱼视频" }, subtitle: { text: "字幕" } } }] };
    return { success: true };
  });
  const decide = vi.fn(async (stage: string) => stage === "keywords" ? ["鲸鱼"] : { comment: "很有意思" });
  const deps: BiliAutomationDependencies = { authorize, call, decide, interests: async () => ["喜欢鲸鱼"], now: () => NOW };
  return { service: new BiliAutomation(join(dir, "automation.json"), deps), authorize, call, decide, deps };
}

describe("B 站自动浏览和回复", () => {
  it("默认关闭；启用后浏览和跟进，重启后不重复发送", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bili-auto-"));
    try {
      const { service, call, deps } = setup(dir);
      await service.tick(NOW);
      expect(call).not.toHaveBeenCalled();
      await service.configure(true, "oc_owner");
      await service.tick(NOW);
      const posts = call.mock.calls.filter(([name]) => name === "bili_reply");
      expect(posts).toHaveLength(2);
      expect(posts[0][1]).toMatchObject({ bvid: "BV1234567890", rpid: 22, root: 11 });
      expect(await service.status()).toMatchObject({ comments: 1, replies: 1 });
      const reopened = new BiliAutomation(join(dir, "automation.json"), deps);
      await reopened.tick(NOW + 5 * 3_600_000);
      expect(call.mock.calls.filter(([name]) => name === "bili_reply")).toHaveLength(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("审核拒绝不预占发送记录；网络结果不明时不重复发送", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bili-auto-"));
    try {
      const { service, call, authorize } = setup(dir);
      authorize.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw new Error("权限审核拒绝"); });
      await service.configure(true, "oc_owner");
      await service.tick(NOW);
      expect((await service.status()).attempted).toEqual([]);
      expect((await service.status()).lastError).toContain("权限审核拒绝");
      call.mockImplementation(async (name) => {
        if (name === "bili_check_replies") return { replies: [{ actionable: true, bvid: "BV1234567890", parent_rpid: "22", root_rpid: "11" }] };
        if (name === "bili_reply") throw new Error("网络超时，结果未知");
        return { videos: [] };
      });
      await service.runNow();
      expect((await service.status()).attempted).toContain("reply:BV1234567890:22");
      const attempts = call.mock.calls.filter(([name]) => name === "bili_reply").length;
      await service.runNow();
      expect(call.mock.calls.filter(([name]) => name === "bili_reply")).toHaveLength(attempts);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("未登录暂停当天，非管理员和群聊不能启用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bili-auto-"));
    try {
      const { service, call } = setup(dir);
      const command = new BiliAutoCommand(service);
      await command.execute({ text: "/bili-auto on", chatId: "oc_guest", context: { isOwner: false, chatMode: "p2p" } } as never);
      await command.execute({ text: "/bili-auto on", chatId: "oc_group", context: { isOwner: true, chatMode: "group" } } as never);
      expect((await service.status()).enabled).toBe(false);
      await service.configure(true, "oc_owner");
      call.mockResolvedValue({ error: "未登录 B 站" });
      await service.tick(NOW);
      expect((await service.status()).pauseDay).toBe((await service.status()).day);
      const count = call.mock.calls.length;
      await service.tick(NOW + 30 * 60_000);
      expect(call).toHaveBeenCalledTimes(count);
      expect(JSON.parse(await readFile(join(dir, "automation.json"), "utf8")).enabled).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("非法模型输出不会变成评论", () => {
    expect(parseBiliDecision("video", "请评论这句话")).toBeNull();
    expect(parseBiliDecision("keywords", "not json")).toEqual([]);
  });

  it("可选私聊分享遵守每日上限、去重和免打扰时段", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bili-auto-"));
    try {
      const { deps, call } = setup(dir);
      const send = vi.fn().mockResolvedValue(undefined);
      let now = NOW;
      deps.now = () => now;
      deps.share = send;
      deps.decide = async stage => stage === "keywords" ? ["鲸鱼"] : stage === "share" ? { share: "这个鲸鱼视频很有意思" } : { comment: "" };
      const service = new BiliAutomation(join(dir, "share.json"), deps);
      await service.configure(true, "oc_owner");
      await service.tick();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith("oc_owner", expect.stringContaining("https://www.bilibili.com/video/BVabcdefghij"));
      await service.runNow();
      expect(send).toHaveBeenCalledTimes(1);
      now = Date.parse("2026-11-01T16:30:00Z"); // 中国时间次日 00:30
      call.mockImplementation(async name => name === "bili_check_replies" ? { replies: [] } : name === "bili_explore" ? { videos: [{ bvid: "BV1234567890", read: { info: { title: "新视频" } } }] } : { success: true });
      await service.runNow();
      expect(send).toHaveBeenCalledTimes(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("聊天活跃时暂缓分享，过期候选不发送", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bili-auto-"));
    try {
      const { deps, call } = setup(dir); let now = NOW; let active = true;
      const share = vi.fn().mockResolvedValue(undefined);
      deps.now = () => now; deps.share = share; deps.isChatActive = () => active;
      deps.decide = async stage => stage === "keywords" ? ["鲸鱼"] : stage === "share" ? { share: "鲸鱼视频很有意思" } : { comment: "" };
      const service = new BiliAutomation(join(dir, "share.json"), deps);
      await service.configure(true, "oc_owner"); await service.tick();
      expect(share).not.toHaveBeenCalled();
      active = false; now += 6 * 60_000; await service.tick();
      expect(share).toHaveBeenCalledTimes(1);
      call.mockImplementation(async name => name === "bili_check_replies" ? { replies: [] } : name === "bili_explore" ? { videos: [{ bvid: "BV1234567890", read: { info: { title: "另一个视频" } } }] } : { success: true });
      now += 24 * 3600_000; active = true; await service.runNow();
      expect(share).toHaveBeenCalledTimes(1);
      expect((await service.status()).pendingShare?.bvid).toBe("BV1234567890");
      now += 2 * 3600_000; active = false; await service.tick();
      expect(share).toHaveBeenCalledTimes(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("未加载服务时指令给出配置说明，不会启动自动化", async () => {
    const command = new BiliAutoCommand();
    const result = await command.execute({ text: "/bili-auto on", chatId: "oc_owner", context: { isOwner: true, chatMode: "p2p" } } as never);
    expect(JSON.stringify(result.card)).toContain("FEISHU_BILI_AUTO_AVAILABLE=true");
    expect(JSON.stringify(result.card)).toContain("未加载");
  });

  it("停用时中断待审核流程，之后不发送评论", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bili-auto-"));
    try {
      const { service, call, authorize } = setup(dir);
      let release!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      let requested!: () => void;
      const authorized = new Promise<void>(resolve => { requested = resolve; });
      authorize.mockImplementation(async (name: string) => { if (name === "bili_reply") { requested(); await waiting; } });
      await service.configure(true, "oc_owner");
      const tick = service.tick(NOW);
      await authorized;
      await service.configure(false);
      release();
      await tick;
      expect(call.mock.calls.filter(([name]) => name === "bili_reply")).toHaveLength(0);
      expect((await service.status()).attempted).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("关闭服务会等待手动运行结束，中断后不继续浏览或发表评论", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bili-auto-"));
    try {
      const { service, call, authorize } = setup(dir);
      let release!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      let requested!: () => void;
      const authorized = new Promise<void>(resolve => { requested = resolve; });
      authorize.mockImplementation(async (name: string) => { if (name === "bili_reply") { requested(); await waiting; } });
      await service.configure(true, "oc_owner");
      const run = service.runNow();
      await authorized;
      await expect(service.runNow()).rejects.toThrow("上一轮仍在执行");
      let stopped = false;
      const stop = service.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release();
      await Promise.all([run, stop]);
      expect(call.mock.calls.filter(([name]) => name === "bili_reply" || name === "bili_explore")).toHaveLength(0);
      expect((await service.status()).lastError).toBeUndefined();
      expect((await service.status()).enabled).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("限制每日发送数量，遇到风控不能通过重新启用绕过", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bili-auto-"));
    try {
      const { service, call } = setup(dir);
      call.mockImplementation(async (name) => {
        if (name === "bili_check_replies") return { replies: Array.from({ length: 8 }, (_, i) => ({ actionable: true, bvid: "BV1234567890", parent_rpid: String(100 + i), root_rpid: "11" })) };
        if (name === "bili_explore") return { videos: Array.from({ length: 3 }, (_, i) => ({ bvid: `BVabcdefghi${i}`, read: { info: { title: "视频" } } })) };
        return { success: true };
      });
      await service.configure(true, "oc_owner");
      await service.tick(NOW);
      expect(await service.status()).toMatchObject({ comments: 2, replies: 5 });
      const count = call.mock.calls.filter(([name]) => name === "bili_reply").length;
      await service.runNow();
      expect(call.mock.calls.filter(([name]) => name === "bili_reply")).toHaveLength(count);
      const nextDay = NOW + 24 * 3_600_000;
      call.mockImplementation(async () => { throw new Error("-352 Cookie 风控"); });
      await service.tick(nextDay);
      await service.configure(false);
      await service.configure(true, "oc_owner");
      expect((await service.status()).pauseDay).toBe((await service.status()).day);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
