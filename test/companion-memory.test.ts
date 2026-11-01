import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanionMemory } from "../src/assistant/companion-memory.ts";

describe("自动对话记忆", () => {
  it("自动保存、跨实例召回，并且拒绝自动硬删除和损坏数据", async () => {
    const dir = await mkdtemp(join(tmpdir(), "companion-memory-"));
    try {
      const extractor = async () => "- ADD [preferences] [importance:3] 用户喜欢蓝鲸";
      const memory = new CompanionMemory(dir, extractor);
      await memory.observe("我喜欢蓝鲸", "记住啦", [{ role: "user", content: "我喜欢蓝鲸" }, { role: "assistant", content: "记住啦" }]);
      const another = new CompanionMemory(dir, async () => "NONE");
      expect(await another.recall("蓝鲸")).toContain("喜欢蓝鲸");
      expect(await another.recall("你还记得我什么？")).toContain("喜欢蓝鲸");
      const item = (await memory.list())[0];
      await memory.setActive(item.id, false);
      expect(await another.recall("蓝鲸")).not.toContain("蓝鲸");
      expect((await memory.list())[0].active).toBe(false);
      await memory.observe("我喜欢蓝鲸", "嗯", []);
      expect((await memory.list()).filter(entry => entry.text === "用户喜欢蓝鲸")).toHaveLength(1);
      expect(await another.recall("蓝鲸")).not.toContain("蓝鲸");
      await memory.setActive(item.id, true);
      expect(await another.recall("蓝鲸")).toContain("蓝鲸");
      const before = await readFile(join(dir, "memory.json"), "utf8");
      const data = JSON.parse(before) as { preferences: Array<{ id: string }> };
      const removing = new CompanionMemory(dir, async () => `- DELETE [${data.preferences[0].id}]`);
      await removing.observe("测试", "好的", []);
      expect(await readFile(join(dir, "memory.json"), "utf8")).toBe(before);
      const events = new CompanionMemory(dir, async () => "- ADD [events] [importance:2] 用户准备去看海");
      await events.observe("我准备去看海", "好呀", []);
      const recent = await events.recall("上次我们聊了什么？");
      expect(recent).toContain("用户准备去看海");
      expect(recent).toContain("并非完整聊天记录");
      await writeFile(join(dir, "memory.json"), "{broken");
      await expect(another.recall("蓝鲸")).rejects.toThrow();
      expect(await readFile(join(dir, "memory.json"), "utf8")).toBe("{broken");
    } finally { delete process.env.FEISHU_MEMORY_DIR; await rm(dir, { recursive: true, force: true }); }
  });
});
