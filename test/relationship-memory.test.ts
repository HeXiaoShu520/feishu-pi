import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelationshipMemory } from "../src/assistant/relationship-memory.ts";

describe("共同经历和证据式印象", () => {
  it("不同原话支持两次才召回印象，重复消息不增加证据，并按人隔离", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relationship-"));
    try {
      let id = "";
      const memory = new RelationshipMemory(dir, async (_system, data) => JSON.stringify([{ kind: "impression", text: "喜欢蓝鲸", quote: data.includes("我一直喜欢蓝鲸") ? "我一直喜欢蓝鲸" : "我特别喜欢蓝鲸", ...(id ? { id } : {}) }]));
      await memory.observe("feishu", "ou_a", "我一直喜欢蓝鲸", "好");
      id = (await memory.list("feishu", "ou_a"))[0].id;
      expect(await memory.recall("feishu", "ou_a", "蓝鲸")).toBe("");
      await memory.observe("feishu", "ou_a", "我一直喜欢蓝鲸", "好");
      expect(await memory.recall("feishu", "ou_a", "蓝鲸")).toBe("");
      await memory.observe("feishu", "ou_a", "我特别喜欢蓝鲸", "好");
      expect(await memory.recall("feishu", "ou_a", "蓝鲸")).toContain("待核实印象");
      expect(await memory.recall("feishu", "ou_b", "蓝鲸")).toBe("");
      const reopened = new RelationshipMemory(dir, async () => "[]");
      expect(await reopened.recall("feishu", "ou_a", "蓝鲸")).toContain("喜欢蓝鲸");
      await reopened.setActive("feishu", "ou_a", id, false);
      expect(await reopened.recall("feishu", "ou_a", "蓝鲸")).toBe("");
      await reopened.setActive("feishu", "ou_a", id, true);
      expect(await reopened.recall("feishu", "ou_a", "蓝鲸")).toContain("喜欢蓝鲸");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("共同聊天只接受真实的用户原话作为依据，明确纠正后保留旧记录", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relationship-"));
    try {
      let answer = JSON.stringify([{ kind: "shared", text: "聊过鲸鱼", quote: "我们刚聊过鲸鱼" }, { kind: "shared", text: "编造经历", quote: "不存在的原话" }]);
      const memory = new RelationshipMemory(dir, async () => answer);
      await memory.observe("feishu", "ou_a", "我们刚聊过鲸鱼", "是的");
      expect(await memory.recall("feishu", "ou_a", "鲸鱼")).toContain("共同聊天");
      expect(await memory.list("feishu", "ou_a")).toHaveLength(1);
      const id = (await memory.list("feishu", "ou_a"))[0].id;
      answer = JSON.stringify([{ op: "invalidate", id, quote: "我们没有聊过鲸鱼" }]);
      await memory.observe("feishu", "ou_a", "我们没有聊过鲸鱼", "明白了");
      expect(await memory.recall("feishu", "ou_a", "鲸鱼")).toBe("");
      expect((await memory.list("feishu", "ou_a"))[0].active).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("重复提及的印象在普通聊天冷却，用户主动询问仍可召回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relationship-"));
    try {
      let output = JSON.stringify([{ kind: "impression", text: "喜欢蓝鲸", quote: "我真的喜欢蓝鲸" }]);
      const memory = new RelationshipMemory(dir, async () => output);
      await memory.observe("feishu", "ou_a", "我真的喜欢蓝鲸", "嗯");
      const id = (await memory.list("feishu", "ou_a"))[0].id;
      output = JSON.stringify([{ kind: "impression", id, text: "喜欢蓝鲸", quote: "我一直喜欢蓝鲸" }]);
      await memory.observe("feishu", "ou_a", "我一直喜欢蓝鲸", "你喜欢蓝鲸");
      output = "[]";
      await memory.observe("feishu", "ou_a", "说点别的吧", "我记得你喜欢蓝鲸");
      expect(await memory.recall("feishu", "ou_a", "蓝鲸")).toBe("");
      expect(await memory.recall("feishu", "ou_a", "你记得我喜欢蓝鲸吗")).toContain("喜欢蓝鲸");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("称呼偏好按人注入，可查看原话、纠正并恢复旧版本", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relationship-"));
    try {
      let output = JSON.stringify([{ kind: "address", text: "希望称呼小鱼", quote: "请叫我小鱼" }, { kind: "boundary", text: "不要调侃工作", quote: "不要调侃我的工作" }]);
      const memory = new RelationshipMemory(dir, async () => output);
      await memory.observe("feishu", "ou_a", "请叫我小鱼，不要调侃我的工作", "好的");
      expect(await memory.recall("feishu", "ou_a", "你好")).toContain("希望称呼小鱼");
      expect(await memory.recall("feishu", "ou_a", "你好")).toContain("不要调侃工作");
      expect(await memory.recall("feishu", "ou_b", "你好")).toBe("");
      expect(await memory.recall("feishu-group", "group:ou_a", "你好")).toBe("");
      const old = (await memory.list("feishu", "ou_a")).find(item => item.category === "称呼偏好")!;
      expect(old.evidence?.[0].quote).toBe("请叫我小鱼");
      output = JSON.stringify([{ op: "update", id: old.id, kind: "address", text: "希望称呼阿鱼", quote: "以后请叫我阿鱼" }]);
      await memory.observe("feishu", "ou_a", "以后请叫我阿鱼", "好的");
      expect(await memory.recall("feishu", "ou_a", "你好")).toContain("希望称呼阿鱼");
      expect(await memory.recall("feishu", "ou_a", "你好")).not.toContain("希望称呼小鱼");
      expect((await memory.list("feishu", "ou_a")).find(item => item.id === old.id)?.evidence?.some(e => e.kind === "correction" && e.quote === "以后请叫我阿鱼")).toBe(true);
      await memory.setActive("feishu", "ou_a", old.id, true);
      expect(await memory.recall("feishu", "ou_a", "你好")).toContain("希望称呼小鱼");
      expect(await memory.recall("feishu", "ou_a", "你好")).not.toContain("希望称呼阿鱼");
      const replacement = (await memory.list("feishu", "ou_a")).find(item => item.text === "希望称呼阿鱼")!;
      await memory.setActive("feishu", "ou_a", replacement.id, true);
      expect(await memory.recall("feishu", "ou_a", "你好")).toContain("希望称呼阿鱼");
      expect(await memory.recall("feishu", "ou_a", "你好")).not.toContain("希望称呼小鱼");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("不把没有明确表述的模型推测当成称呼或边界", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relationship-"));
    try {
      const memory = new RelationshipMemory(dir, async () => JSON.stringify([{ kind: "boundary", text: "不喜欢音乐", quote: "今天听音乐了" }, { kind: "address", text: "叫小明", quote: "今天听音乐了" }]));
      await memory.observe("feishu", "ou_a", "今天听音乐了", "听起来不错");
      expect(await memory.list("feishu", "ou_a")).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
