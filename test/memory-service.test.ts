import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService, selectMemories, type MemoryContext, type MemoryEntry } from "../src/memory/service.ts";

const privateChat: MemoryContext = { chatId: "private-a", chatMode: "p2p" };
const rooms: MemoryContext[] = [privateChat, { chatId: "g1", chatMode: "group" }, { chatId: "g2", chatMode: "group" },
  { chatId: "g3", chatMode: "topic", threadId: "t1" }, { chatId: "g3", chatMode: "topic", threadId: "t2" }];
const dirs: string[] = [];
const services: MemoryService[] = [];
const item = (evidence = "我喜欢猫", summary = "用户喜欢猫。", topic = "宠物偏好") =>
  ({ kind: "preference", topic, summary, evidence, keywords: ["猫咪", "宠物"] });
const patch = (...remember: ReturnType<typeof item>[]) => JSON.stringify({ remember, forget: [] });
async function setup(complete = vi.fn(async (_system: string, _user: string) => patch(item())), options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "memory-v2-"));
  dirs.push(dir);
  const memory = new MemoryService(dir, complete, { intervalMs: 0, ...options });
  services.push(memory);
  return { dir, memory, complete };
}
afterEach(async () => {
  for (const memory of services.splice(0)) await memory.flush();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("有来源的分域记忆", () => {
  it("保存用户原话依据并跨实例读取", async () => {
    const { dir, memory } = await setup();
    await memory.observe({ openId: "a", context: privateChat, userText: "我喜欢猫", assistantText: "我也觉得猫可爱" });
    const restarted = new MemoryService(dir, async () => "");
    const recalled = await restarted.recall("a", privateChat);
    expect(recalled).toContain("用户喜欢猫");
    expect(recalled).toContain('"evidence":"我喜欢猫"');
  });

  it("同一个人私聊、不同群、不同话题互相隔离", async () => {
    const { memory } = await setup();
    await memory.observe({ openId: "a", context: privateChat, userText: "我喜欢猫", assistantText: "知道啦" });
    for (const context of rooms.slice(1)) expect(await memory.recall("a", context)).toBe("");
    expect(await memory.recall("b", privateChat)).toBe("");
    expect(await memory.recall("a")).toBe("");
    await memory.observe({ openId: "a", context: rooms[3], userText: "我喜欢猫", assistantText: "知道啦" });
    expect(await memory.recall("a", rooms[3])).toContain("用户喜欢猫");
    expect(await memory.recall("a", rooms[4])).toBe("");
  });

  it("不读取或改写旧的全局人格记忆", async () => {
    const { dir, memory } = await setup();
    await writeFile(join(dir, "self.md"), "见到爱就先愣一下", "utf8");
    await writeFile(join(dir, "persona-growth.md"), "夸人就先损一句", "utf8");
    await mkdir(join(dir, "people"));
    await writeFile(join(dir, "people", "legacy.md"), "私聊秘密", "utf8");
    expect(await memory.recall("a", privateChat)).toBe("");
    await memory.observe({ openId: "a", userText: "我喜欢猫", assistantText: "嗯" });
    expect(await readFile(join(dir, "self.md"), "utf8")).toBe("见到爱就先愣一下");
  });

  it("拒绝助手自编经历和没有当前用户原话的证据", async () => {
    const { memory } = await setup(vi.fn(async () => patch(item("我刚去吃饭了", "大肥鱼刚吃了饭。"))));
    await memory.observe({ openId: "a", userText: "你在干嘛", assistantText: "我刚去吃饭了" });
    expect(await memory.recall("a")).toBe("");
  });

  it("拒绝把记忆写成固定反应指令", async () => {
    const { memory } = await setup(vi.fn(async () => patch(item("我喜欢猫", "每次都要先损一句再夸。"))));
    await memory.observe({ openId: "a", userText: "我喜欢猫", assistantText: "嗯" });
    expect(await memory.recall("a")).toBe("");
  });

  it("明确反馈可以作为相处偏好保存", async () => {
    const { memory } = await setup(vi.fn(async () => patch(item("别老提白饭了", "用户不喜欢反复提白饭。", "表达偏好"))));
    await memory.observe({ openId: "a", userText: "别老提白饭了", assistantText: "好" });
    expect(await memory.recall("a")).toContain("用户不喜欢反复提白饭");
  });

  it("按同一主题更正事实，不积累互相冲突的版本", async () => {
    const complete = vi.fn().mockResolvedValueOnce(patch(item())).mockResolvedValueOnce(patch(item("我现在喜欢狗", "用户现在喜欢狗。")));
    const { memory } = await setup(complete);
    await memory.observe({ openId: "a", userText: "我喜欢猫", assistantText: "嗯" });
    await memory.observe({ openId: "a", userText: "我现在喜欢狗", assistantText: "好" });
    const recalled = await memory.recall("a");
    expect(recalled).toContain("用户现在喜欢狗");
    expect(recalled).not.toContain("用户喜欢猫");
  });

  it("只有当前用户的明确撤销证据才能删除旧条目", async () => {
    const { memory, complete } = await setup();
    await memory.observe({ openId: "a", userText: "我喜欢猫", assistantText: "嗯" });
    complete.mockImplementation(async (_system?: string, user?: string) => {
      const id = JSON.parse(user!).existing[0].id;
      return JSON.stringify({ remember: [], forget: [{ id, evidence: "请忘记我的宠物偏好" }] });
    });
    await memory.observe({ openId: "a", userText: "随便聊聊", assistantText: "嗯" });
    expect(await memory.recall("a")).toContain("用户喜欢猫");
    await memory.observe({ openId: "a", userText: "请忘记我的宠物偏好", assistantText: "好" });
    expect(await memory.recall("a")).toBe("");
  });

  it("模型失败或输出坏 JSON 时保留已有记忆", async () => {
    const { memory, complete } = await setup();
    await memory.observe({ openId: "a", userText: "我喜欢猫", assistantText: "嗯" });
    complete.mockResolvedValueOnce("not JSON");
    await memory.observe({ openId: "a", userText: "第二句", assistantText: "嗯" });
    complete.mockRejectedValueOnce(new Error("offline"));
    await memory.observe({ openId: "a", userText: "第三句", assistantText: "嗯" });
    expect(await memory.recall("a")).toContain("用户喜欢猫");
  });

  it("敏感内容不送提炼模型", async () => {
    const { memory, complete } = await setup();
    await memory.observe({ openId: "a", userText: "密码是 123456", assistantText: "别发密码" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("损坏的存储不被下一次提炼覆盖", async () => {
    const { memory, dir } = await setup();
    await memory.observe({ openId: "a", userText: "我喜欢猫", assistantText: "嗯" });
    const files = await readdir(join(dir, "v2"));
    const path = join(dir, "v2", files[0]);
    await writeFile(path, "broken data", "utf8");
    await memory.observe({ openId: "a", userText: "我喜欢猫", assistantText: "嗯" });
    expect(await readFile(path, "utf8")).toBe("broken data");
  });

  it.each([
    { field: "summary", value: "x".repeat(121) },
    { field: "updatedAt", value: 1e99 },
    { field: "keywords", value: ["a", "b", "c", "d", "e", "f"] },
  ])("存储字段越界时不注入、不覆盖：$field", async ({ field, value }) => {
    const { memory, dir } = await setup();
    await memory.observe({ openId: "a", userText: "我喜欢猫", assistantText: "嗯" });
    const files = await readdir(join(dir, "v2"));
    const path = join(dir, "v2", files[0]);
    const data = JSON.parse(await readFile(path, "utf8"));
    data.entries[0][field] = value;
    const invalid = JSON.stringify(data);
    await writeFile(path, invalid, "utf8");
    expect(await memory.recall("a")).toBe("");
    await memory.observe({ openId: "a", userText: "我喜欢猫", assistantText: "嗯" });
    expect(await readFile(path, "utf8")).toBe(invalid);
  });

  it("提醒别忘记不是删除授权", async () => {
    const { memory, complete } = await setup();
    await memory.observe({ openId: "a", userText: "我喜欢猫", assistantText: "嗯" });
    complete.mockImplementation(async (_system: string, user: string) => JSON.stringify({ remember: [],
      forget: [{ id: JSON.parse(user).existing[0].id, evidence: "别忘记我的宠物偏好" }] }));
    await memory.observe({ openId: "a", userText: "别忘记我的宠物偏好", assistantText: "好" });
    expect(await memory.recall("a")).toContain("用户喜欢猫");
  });

  it("同批删除后不能又被remember或reflections重新写回来", async () => {
    const { memory, complete } = await setup();
    await memory.observe({ openId: "a", userText: "我喜欢猫", assistantText: "嗯" });
    const evidence = "请忘记我的宠物偏好，我以前喜欢猫";
    complete.mockImplementationOnce(async (_system: string, user: string) => JSON.stringify({
      forget: [{ id: JSON.parse(user).existing[0].id, evidence }], remember: [item(evidence)],
      reflections: [{ kind: "interest", topic: "宠物偏好", summary: "我想聊猫咪。", evidence,
        assistantEvidence: "我想聊猫咪。", keywords: ["猫咪"] }],
    }));
    await memory.observe({ openId: "a", userText: evidence, assistantText: "我想聊猫咪。" });
    expect(await memory.recall("a", undefined, "猫咪")).toBe("");
  });

  it("节流缓冲保持一问一答配对，退出时处理最后一批", async () => {
    const complete = vi.fn(async (_system: string, _user: string) => patch());
    const { memory } = await setup(complete, { intervalMs: 60_000 });
    await memory.observe({ openId: "a", userText: "第一句", assistantText: "回答一" });
    await memory.observe({ openId: "a", userText: "第二句", assistantText: "回答二" });
    await memory.observe({ openId: "a", userText: "第三句", assistantText: "回答三" });
    expect(complete).toHaveBeenCalledTimes(1);
    await memory.flush();
    const payload = JSON.parse(complete.mock.calls[1][1]);
    expect(payload.turns).toMatchObject([{ user: "第二句", assistant: "回答二" }, { user: "第三句", assistant: "回答三" }]);
  });

  it("同域并发提炼串行合并，不丢前一条更新", async () => {
    const complete = vi.fn(async (_system: string, user: string) => {
      const value = JSON.parse(user);
      return patch(item(value.turns[0].user, value.turns[0].user, value.turns[0].user));
    });
    const { memory, dir } = await setup(complete);
    await Promise.all([memory.observe({ openId: "a", userText: "喜欢猫咪", assistantText: "嗯" }),
      memory.observe({ openId: "a", userText: "喜欢咖啡", assistantText: "嗯" })]);
    const files = await readdir(join(dir, "v2"));
    const store = JSON.parse(await readFile(join(dir, "v2", files[0]), "utf8"));
    expect(store.entries).toHaveLength(2);
  });

  it("节流尾部即使没有下一条消息也会定时排空", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { memory, complete } = await setup(vi.fn(async (_system: string, _user: string) => patch()), { intervalMs: 60_000 });
      await memory.observe({ openId: "a", userText: "第一句", assistantText: "嗯" });
      await memory.observe({ openId: "a", userText: "最后一句", assistantText: "好" });
      expect(complete).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_001);
      await memory.flush();
      expect(complete).toHaveBeenCalledTimes(2);
      expect(JSON.parse(complete.mock.calls[1][1]).turns[0].user).toBe("最后一句");
    } finally { vi.useRealTimers(); }
  });
});

describe("相关性与预算", () => {
  const entry = (kind: MemoryEntry["kind"], keyword: string, time: number): MemoryEntry => ({
    id: keyword, kind, topic: keyword, summary: keyword, evidence: keyword, keywords: [keyword], observedAt: time, updatedAt: time,
  });
  it("只带入相关事实、近期经历和少量相处偏好", () => {
    const now = 10 * 24 * 60 * 60_000;
    const entries = [entry("fact", "咖啡", 1), entry("fact", "猫咪", 1), entry("episode", "考试", 1),
      entry("boundary", "不要损我", 1), entry("episode", "今天加班", now)];
    const selected = selectMemories(entries, "咖啡喝多了", now);
    expect(selected.map(e => e.topic)).toEqual(["不要损我", "咖啡", "今天加班"]);
    expect(selectMemories(entries, "咖啡喝多了", now, 1)).toHaveLength(1);
  });

  it("相关事实再多也不挤掉明确的相处边界", () => {
    const entries = [...Array.from({ length: 8 }, () => entry("fact", "咖啡", 10)), entry("boundary", "不要损我", 1)];
    expect(selectMemories(entries, "咖啡", 20, 6)[0].kind).toBe("boundary");
  });

  it("单字关键词只在输入完全匹配时触发", () => {
    const entries = [entry("fact", "茶", 1)];
    expect(selectMemories(entries, "茶", 20)).toHaveLength(1);
    expect(selectMemories(entries, "奶茶店", 20)).toHaveLength(0);
  });
});
