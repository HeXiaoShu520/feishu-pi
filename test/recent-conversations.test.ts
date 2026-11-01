import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecentConversations } from "../src/assistant/recent-conversations.ts";

describe("按人保存近期对话", () => {
  it("跨实例恢复、保持顺序且按用户和平台隔离", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fish-recent-"));
    try {
      const history = new RecentConversations(dir);
      await Promise.all([history.record("feishu", "ou_a", "今天去爬山", "山顶风大"), history.record("feishu", "ou_a", "下周去看海", "记下啦")]);
      const reopened = new RecentConversations(dir);
      const recalled = await reopened.recall("feishu", "ou_a");
      expect(recalled).toContain("今天去爬山");
      expect(recalled.indexOf("今天去爬山")).toBeLessThan(recalled.indexOf("下周去看海"));
      expect(await reopened.recall("feishu", "ou_b")).toBe("");
      expect(await reopened.recall("bilibili", "ou_a")).toBe("");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("整轮过滤凭证，最多保存40轮且读取最近3轮", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fish-recent-"));
    try {
      const history = new RecentConversations(dir);
      await history.record("feishu", "ou_a", "密码是abc", "记住abc");
      for (let i = 0; i < 42; i++) await history.record("feishu", "ou_a", `记录-${i}`, `回复-${i}`);
      const data = JSON.parse(await readFile(join(dir, (await readdir(dir))[0]), "utf8"));
      expect(data.turns).toHaveLength(40);
      expect(JSON.stringify(data)).not.toContain("abc");
      const recalled = await history.recall("feishu", "ou_a");
      expect(recalled).toContain("记录-41");
      expect(recalled).not.toContain("记录-38");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("数据损坏时不覆盖原文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fish-recent-"));
    try {
      const history = new RecentConversations(dir);
      await history.record("feishu", "ou_a", "你好", "你好");
      const file = join(dir, (await readdir(dir))[0]);
      await writeFile(file, "{broken", "utf8");
      await expect(history.record("feishu", "ou_a", "再见", "再见")).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe("{broken");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("按话题检索该用户更早的片段，不将未命中当作从未聊过", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fish-recent-"));
    try {
      const history = new RecentConversations(dir);
      await history.record("feishu", "ou_a", "我们讨论了蓝鲸迁徙", "蓝鲸会迁徙");
      await history.record("feishu", "ou_a", "今天去跑步", "注意休息");
      await history.record("feishu", "ou_b", "我养了一只猫", "猫很可爱");
      expect(await history.search("feishu", "ou_a", "蓝鲸")).toContain("蓝鲸迁徙");
      expect(await history.search("feishu", "ou_b", "蓝鲸")).not.toContain("蓝鲸迁徙");
      expect(await history.search("feishu", "ou_a", "月球基地")).toContain("不代表从未聊过");
      expect(await history.search("feishu", "ou_b", "猫")).toContain("我养了一只猫");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
