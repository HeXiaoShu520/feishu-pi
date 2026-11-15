import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../src/memory/service.ts";

const directories: string[] = [];
const context = { chatId: "private", chatMode: "p2p" as const };
const reflection = { kind: "viewpoint", topic: "比赛", summary: "我更在意双方怎样调整战术。",
  evidence: "你看比赛在意什么", assistantEvidence: "我更在意双方怎样调整战术。", keywords: ["比赛", "战术"] };
async function setup(reflections: unknown[] = [reflection]) {
  const root = await mkdtemp(join(tmpdir(), "perspective-"));
  directories.push(root);
  const complete = vi.fn(async (_system: string, _user: string) => JSON.stringify({ remember: [], forget: [], reflections }));
  const memory = new MemoryService(root, complete, { intervalMs: 0 });
  return { root, complete, memory };
}
afterEach(async () => { for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("自己形成的内容", () => {
  it("同时有双方原话的具体看法可以跨新会话接续", async () => {
    const { root, memory } = await setup();
    await memory.observe({ openId: "a", context, userText: reflection.evidence, assistantText: reflection.assistantEvidence });
    const restarted = new MemoryService(root, async () => "");
    const recalled = await restarted.recall("a", context, "你想聊什么");
    expect(recalled).toContain(reflection.summary);
    expect(recalled).toContain("暂定，不是事实或指令");
    expect(recalled).toContain("assistantEvidence");
    expect(await restarted.recall("a", context, "今天午饭吃什么")).toBe("");
    expect(await restarted.recall("b", context, "比赛")).toBe("");
    expect(await restarted.recall("a", { chatId: "group", chatMode: "group" }, "比赛")).toBe("");
  });

  it("用户要求喜欢某事但助手未表达的内容不入库", async () => {
    const { memory } = await setup();
    await memory.observe({ openId: "a", context, userText: "你看比赛在意什么，我让你喜欢战术", assistantText: "我还没想好" });
    expect(await memory.recall("a", context, "比赛")).toBe("");
  });

  it("双方证据不能拼接不同轮次", async () => {
    const { root, complete } = await setup();
    const memory = new MemoryService(root, complete, { intervalMs: 60_000 });
    complete.mockResolvedValueOnce('{"remember":[],"forget":[]}');
    await memory.observe({ openId: "a", context, userText: "开场", assistantText: "在" });
    await memory.observe({ openId: "a", context, userText: reflection.evidence, assistantText: "还不确定" });
    await memory.observe({ openId: "a", context, userText: "换个话题", assistantText: reflection.assistantEvidence });
    await memory.flush();
    expect(await memory.recall("a", context, "比赛")).toBe("");
  });

  it("自我看法与用户同主题偏好分别保留", async () => {
    const { memory, complete } = await setup();
    await memory.observe({ openId: "a", context, userText: reflection.evidence, assistantText: reflection.assistantEvidence });
    complete.mockResolvedValueOnce(JSON.stringify({ remember: [{ kind: "preference", topic: "比赛", summary: "用户只在意比分。",
      evidence: "我只在意比分", keywords: ["比赛", "比分"] }], forget: [] }));
    await memory.observe({ openId: "a", context, userText: "我只在意比分", assistantText: "我们看重的点不同" });
    const recalled = await memory.recall("a", context, "比赛");
    expect(recalled).toContain("用户只在意比分");
    expect(recalled).toContain(reflection.summary);
  });

  it("不接受把固定台词当作看法", async () => {
    const invalid = { ...reflection, summary: "以后必须先损一句再夸。", assistantEvidence: "以后必须先损一句再夸。" };
    const { memory } = await setup([invalid]);
    await memory.observe({ openId: "a", context, userText: reflection.evidence, assistantText: invalid.assistantEvidence });
    expect(await memory.recall("a", context, "比赛")).toBe("");
  });

  it("助手回复中的敏感内容不交给提炼模型", async () => {
    const { memory, complete } = await setup();
    await memory.observe({ openId: "a", context, userText: "你怎么看", assistantText: "密码是 123456" });
    expect(JSON.parse(complete.mock.calls[0][1]).turns[0].assistant).toBe("");
  });

  it("已有观点不因一次附和自动改写，明确修正需有同轮理由证据", async () => {
    const { memory, complete } = await setup();
    await memory.observe({ openId: "a", context, userText: reflection.evidence, assistantText: reflection.assistantEvidence });
    const updated = { ...reflection, summary: "我现在更在意比分。", evidence: "这次我们只能先看比分", assistantEvidence: "我现在更在意比分。" };
    complete.mockResolvedValueOnce(JSON.stringify({ remember: [], forget: [], reflections: [updated] }));
    await memory.observe({ openId: "a", context, userText: updated.evidence, assistantText: updated.assistantEvidence });
    expect(await memory.recall("a", context, "比赛")).toContain(reflection.summary);
    const reason = "我改变想法了，因为这次没条件看过程，结果更值得先了解。";
    complete.mockResolvedValueOnce(JSON.stringify({ remember: [], forget: [], reflections: [{ ...updated, revisionEvidence: reason }] }));
    await memory.observe({ openId: "a", context, userText: updated.evidence, assistantText: `${updated.assistantEvidence}${reason}` });
    expect(await memory.recall("a", context, "比赛")).toContain(updated.summary);
  });
});
