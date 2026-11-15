import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../src/memory/service.ts";
import { buildUserProfile } from "../src/memory/profile.ts";
import { createProfileUpdateTool } from "../src/memory/tool.ts";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
it("AI内部画像从有原话依据的记忆形成，按人和聊天隔离", async () => {
  const root = await mkdtemp(join(tmpdir(), "internal-profile-")); dirs.push(root);
  const memory = new MemoryService(root, async () => JSON.stringify({ remember: [{ kind: "preference", topic: "闲聊篇幅",
    summary: "用户喜欢简短聊天", evidence: "我喜欢简短聊天", keywords: ["聊天"] }], forget: [] }), { intervalMs: 0 });
  const ctx = { chatId: "private-a", chatMode: "p2p" as const };
  await memory.observe({ openId: "a", context: ctx, userText: "我喜欢简短聊天", assistantText: "好" });
  const profile = await memory.profile("a", ctx);
  expect(profile.sections[0]?.items[0]?.evidence).toBe("我喜欢简短聊天");
  expect(profile.sections[0]?.items[0]?.status).toContain("未经独立核实");
  for (const [id, context] of [["b", ctx], ["a", { chatId: "g", chatMode: "group" as const }]] as const) {
    expect((await memory.profile(id, context)).sections.every(s => !s.items.length)).toBe(true);
  }
  expect("editProfile" in memory).toBe(false);
});
it("画像不混入助手自我视角资料", () => {
  expect(buildUserProfile([{ subject: "self", kind: "interest" } as never]).sections.every(s => !s.items.length)).toBe(true);
});
it("同一个人在私聊、群和话题共用画像，更新与删除也跨聊天生效", async () => {
  const root = await mkdtemp(join(tmpdir(), "person-profile-")); dirs.push(root);
  const memory = new MemoryService(root, async () => '{"remember":[],"forget":[]}', { userUpdates: "agent" });
  const privateChat = { chatId: "p", chatMode: "p2p" as const };
  const group = { chatId: "g", chatMode: "group" as const };
  const topic = { chatId: "g2", chatMode: "topic" as const, threadId: "t" };
  const update = { action: "remember" as const, kind: "preference" as const, topic: "聊天篇幅",
    summary: "用户喜欢简短聊天", evidence: "我喜欢简短聊天", keywords: ["聊天"] };
  await memory.updateProfile("a", privateChat, update.evidence, update);
  for (const context of [privateChat, group, topic]) expect(await memory.recall("a", context)).toContain(update.summary);
  expect(await memory.recall("b", group)).toBe("");
  await memory.updateProfile("a", group, "我希望讲详细一点", { ...update, summary: "用户希望详细说明", evidence: "我希望讲详细一点" });
  expect(await memory.recall("a", privateChat)).toContain("用户希望详细说明");
  const id = (await memory.profile("a", topic)).sections[0]!.items[0]!.id;
  await memory.updateProfile("a", topic, "忘记这个偏好", { action: "forget", id, evidence: "忘记这个偏好" });
  expect(await memory.recall("a", privateChat)).toBe("");
});
it("同一个人在不同群同时更新，不丢失画像条目", async () => {
  const root = await mkdtemp(join(tmpdir(), "person-profile-concurrent-")); dirs.push(root);
  const memory = new MemoryService(root, async () => "", { userUpdates: "agent" });
  await Promise.all(["g1", "g2"].map(chatId => memory.updateProfile("a", { chatId, chatMode: "group" }, "我喜欢猫也喜欢狗", {
    action: "remember", kind: "preference", topic: chatId, summary: chatId === "g1" ? "用户喜欢猫" : "用户喜欢狗",
    evidence: "我喜欢猫也喜欢狗", keywords: ["宠物"],
  })));
  expect((await memory.profile("a", { chatId: "p", chatMode: "p2p" })).sections[0]?.items).toHaveLength(2);
});
it("自主模式只有AI明确调用才更新画像，后台不再自动写用户条目", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-profile-")); dirs.push(root);
  const ctx = { chatId: "p", chatMode: "p2p" as const };
  const memory = new MemoryService(root, async () => JSON.stringify({ remember: [{ kind: "preference", topic: "篇幅",
    summary: "用户喜欢简短聊天", evidence: "我喜欢简短聊天", keywords: ["聊天"] }], forget: [] }), { userUpdates: "agent", intervalMs: 0 });
  await memory.observe({ openId: "a", context: ctx, userText: "我喜欢简短聊天", assistantText: "好" });
  expect((await memory.profile("a", ctx)).sections.every(s => !s.items.length)).toBe(true);
  const update = { action: "remember" as const, kind: "preference" as const, topic: "篇幅", summary: "用户喜欢简短聊天",
    evidence: "我喜欢简短聊天", keywords: ["聊天"] };
  await memory.updateProfile("a", ctx, "我喜欢简短聊天", update);
  await memory.updateProfile("a", ctx, "技术问题我想听详细点", { ...update, summary: "用户希望技术问题详细说明", evidence: "技术问题我想听详细点" });
  expect((await memory.profile("a", ctx)).sections[0]?.items).toHaveLength(1);
  expect(await memory.recall("a", ctx)).toContain("技术问题详细说明");
  await expect(memory.updateProfile("a", ctx, "你好", update)).rejects.toThrow("本轮");
  const id = (await memory.profile("a", ctx)).sections[0]!.items[0]!.id;
  await expect(memory.updateProfile("b", ctx, "忘记这个偏好", { action: "forget", id, evidence: "忘记这个偏好" })).rejects.toThrow("没有对应");
  await memory.updateProfile("a", ctx, "忘记这个偏好", { action: "forget", id, evidence: "忘记这个偏好" });
  expect((await memory.profile("a", ctx)).sections.every(s => !s.items.length)).toBe(true);
});
it("内部工具只接受宿主绑定的当轮发言，不接受模型伪造目标人", async () => {
  let current: string | undefined;
  const calls: unknown[][] = [];
  const memory = { updateProfile: async (...args: unknown[]) => { calls.push(args); return "id"; } };
  const ctx = { chatId: "g", chatMode: "group" as const };
  const tool = createProfileUpdateTool(memory, "a", ctx, () => current);
  const args = { action: "remember", evidence: "喜欢猫", openId: "b", chatId: "other" };
  await expect(tool.execute("call", args as never)).rejects.toThrow("没有正在处理");
  current = "我喜欢猫";
  await tool.execute("call", args as never);
  expect(calls[0]?.slice(0, 3)).toEqual(["a", ctx, "我喜欢猫"]);
  current = undefined;
  await expect(tool.execute("call", args as never)).rejects.toThrow();
});
