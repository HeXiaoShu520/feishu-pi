import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonMemory } from "../src/assistant/person-memory.ts";

describe("按平台和用户隔离的人物记忆", () => {
  it("提取、重启召回、纠正并保留旧版本，不混淆不同人和平台", async () => {
    const dir = await mkdtemp(join(tmpdir(), "people-memory-"));
    try {
      let answer = JSON.stringify([{ op: "add", category: "preference", text: "喜欢蓝鲸", importance: 3 }]);
      const memory = new PersonMemory(dir, async () => answer);
      await memory.observe("feishu", "ou_A", "我喜欢蓝鲸", "记住了", []);
      answer = JSON.stringify([{ op: "add", category: "preference", text: "喜欢猫", importance: 2 }]);
      await memory.observe("feishu", "ou_B", "我喜欢猫", "好的", []);
      await memory.observe("bilibili", "ou_A", "我喜欢猫", "好的", []);
      const reopened = new PersonMemory(dir, async () => answer);
      expect(await reopened.recall("feishu", "ou_A", "蓝鲸")).toContain("喜欢蓝鲸");
      expect(await reopened.recall("feishu", "ou_B", "蓝鲸")).not.toContain("蓝鲸");
      expect(await reopened.recall("bilibili", "ou_A", "猫")).toContain("喜欢猫");
      const files = await readdir(dir);
      const records = await Promise.all(files.map(async file => JSON.parse(await readFile(join(dir, file), "utf8"))));
      const a = records.find(record => record.platform === "feishu" && record.personId === "ou_A");
      answer = JSON.stringify([{ op: "update", id: a.facts[0].id, category: "preference", text: "现在喜欢海豚", importance: 3 }]);
      await memory.observe("feishu", "ou_A", "我现在更喜欢海豚", "记住了", []);
      const updated = JSON.parse(await readFile(join(dir, files.find((_, index) => records[index] === a)!), "utf8"));
      expect(updated.facts[0].invalidAt).toBeTruthy();
      expect(updated.facts[0].replacedBy).toBe(updated.facts[1].id);
      expect(await reopened.recall("feishu", "ou_A", "海豚")).toContain("现在喜欢海豚");
      expect(await reopened.recall("feishu", "ou_A", "蓝鲸")).not.toContain("蓝鲸");
      const original = (await memory.list("feishu", "ou_A")).find(item => item.text === "喜欢蓝鲸")!;
      expect(original.active).toBe(false);
      await expect(memory.setActive("feishu", "ou_B", original.id, true)).rejects.toThrow("没有找到");
      await memory.setActive("feishu", "ou_A", original.id, true);
      expect(await memory.recall("feishu", "ou_A", "蓝鲸")).toContain("喜欢蓝鲸");
      expect(await memory.recall("feishu", "ou_A", "海豚")).not.toContain("海豚");
      await memory.setActive("feishu", "ou_A", original.id, false);
      expect(await memory.recall("feishu", "ou_A", "蓝鲸")).not.toContain("蓝鲸");
      answer = JSON.stringify([{ op: "add", category: "preference", text: "喜欢蓝鲸", importance: 3 }]);
      await memory.observe("feishu", "ou_A", "蓝鲸", "嗯", []);
      expect((await memory.list("feishu", "ou_A")).filter(item => item.text === "喜欢蓝鲸")).toHaveLength(1);
      expect(await memory.recall("feishu", "ou_A", "蓝鲸")).not.toContain("蓝鲸");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("并发同一人的提取不丢失，凭证不进入记忆", async () => {
    const dir = await mkdtemp(join(tmpdir(), "people-memory-"));
    try {
      const memory = new PersonMemory(dir, async (_system, text) => JSON.stringify([{ op: "add", category: "event", text: text.includes("当前说话人：我去登山") ? "去登山" : "去游泳", importance: 2 }]));
      await Promise.all([memory.observe("feishu", "ou_A", "我去登山", "好", []), memory.observe("feishu", "ou_A", "我去游泳", "好", [])]);
      await memory.observe("feishu", "ou_A", "我的密码是123456", "知道了", []);
      const store = JSON.parse(await readFile(join(dir, (await readdir(dir))[0]), "utf8"));
      expect(store.facts.map((fact: { text: string }) => fact.text)).toEqual(["去登山", "去游泳"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("刚认识一个人时也能召回低重要度的精确匹配", async () => {
    const dir = await mkdtemp(join(tmpdir(), "people-memory-"));
    try {
      const memory = new PersonMemory(dir, async () => JSON.stringify([{ op: "add", category: "preference", text: "一直喜欢吃草莓", importance: 1 }]));
      await memory.observe("feishu", "ou_A", "我喜欢草莓", "好的", []);
      expect(await memory.recall("feishu", "ou_A", "草莓")).toContain("草莓");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("询问对我的记忆时返回本人事实，不混入其他人", async () => {
    const dir = await mkdtemp(join(tmpdir(), "people-memory-"));
    try {
      const memory = new PersonMemory(dir, async () => JSON.stringify([{ op: "add", category: "preference", text: "喜欢草莓", importance: 2 }]));
      await memory.observe("feishu", "ou_A", "我喜欢草莓", "好的", []);
      expect(await memory.recall("feishu", "ou_A", "你还记得我什么？")).toContain("喜欢草莓");
      expect(await memory.recall("feishu", "ou_B", "你还记得我什么？")).toBe("");
      expect(await memory.recall("feishu", "ou_A", "今天的天气怎么样？")).not.toContain("草莓");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("回顾最近聊天时优先提供个人经历及记录日期", async () => {
    const dir = await mkdtemp(join(tmpdir(), "people-memory-"));
    try {
      let output = JSON.stringify([{ op: "add", category: "event", text: "计划去看海", importance: 2 }]);
      const memory = new PersonMemory(dir, async () => output);
      await memory.observe("feishu", "ou_A", "我计划去看海", "好的", []);
      output = JSON.stringify([{ op: "add", category: "preference", text: "喜欢猫", importance: 3 }]);
      await memory.observe("feishu", "ou_A", "我喜欢猫", "好的", []);
      const result = await memory.recall("feishu", "ou_A", "上次我们聊了什么？");
      expect(result).toContain("计划去看海");
      expect(result).toMatch(/记录于 \d{4}-\d{2}-\d{2}/);
      expect(result).toContain("并非完整聊天记录");
      expect(result).not.toContain("喜欢猫");
      expect(await memory.recall("feishu", "ou_B", "上次我们聊了什么？")).not.toContain("看海");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("提取时提供最近对话以理解代词，并过滤含凭证的历史", async () => {
    const dir = await mkdtemp(join(tmpdir(), "people-memory-"));
    try {
      let captured = "";
      const memory = new PersonMemory(dir, async (_system, text) => { captured = text; return "[]"; });
      await memory.observe("feishu", "ou_A", "不对，是樱桃", "记住了", [
        { role: "user", content: "我喜欢草莓" }, { role: "assistant", content: "你喜欢草莓" },
        { role: "user", content: "密码是abcd" }, { role: "user", content: "不对，是樱桃" },
      ]);
      expect(captured).toContain("我喜欢草莓");
      expect(captured).not.toContain("密码是abcd");
      expect(captured).toContain("当前说话人：不对，是樱桃");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("后台模型尚未返回时可立即召回已有记忆，后续提炼仍按时间顺序提交", async () => {
    const dir = await mkdtemp(join(tmpdir(), "people-memory-"));
    let release!: () => void;
    const slow = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    try {
      let calls = 0;
      const memory = new PersonMemory(dir, async () => {
        calls++;
        if (calls === 2) { started(); await slow; }
        return JSON.stringify([{ op: "add", category: "preference", text: calls === 1 ? "喜欢草莓" : calls === 2 ? "喜欢苹果" : "喜欢葡萄", importance: 2 }]);
      });
      await memory.observe("feishu", "ou_A", "草莓", "好", []);
      const second = memory.observe("feishu", "ou_A", "苹果", "好", []);
      await running;
      const third = memory.observe("feishu", "ou_A", "葡萄", "好", []);
      const recall = await Promise.race([memory.recall("feishu", "ou_A", "草莓"), new Promise<string>(resolve => setTimeout(() => resolve("超时"), 500))]);
      expect(recall).toContain("草莓");
      release();
      await Promise.all([second, third]);
      expect(await memory.recall("feishu", "ou_A", "葡萄")).toContain("葡萄");
    } finally { release(); await rm(dir, { recursive: true, force: true }); }
  });
});
