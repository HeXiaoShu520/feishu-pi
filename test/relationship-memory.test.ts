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
});
