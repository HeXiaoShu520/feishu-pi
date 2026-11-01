import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchPrivateSessions } from "../src/assistant/session-history.ts";

describe("历史私聊检索", () => {
  it("检索本人旧会话，拒绝其他用户、群聊与凭证轮次", async () => {
    const root = await mkdtemp(join(tmpdir(), "fish-session-history-"));
    const make = async (name: string, owner: string, conversationId: string, user: string, assistant: string) => {
      const dir = join(root, name); await mkdir(dir);
      await writeFile(join(dir, "session.json"), JSON.stringify({ ownerOpenId: owner, conversationId }));
      const entries = [
        { type: "message", timestamp: "2026-10-01T01:00:00Z", message: { role: "user", content: user } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: assistant }] } },
      ];
      await writeFile(join(dir, "old.jsonl"), `null\n{broken\n${entries.map(item => JSON.stringify(item)).join("\n")}`);
    };
    try {
      await make("20261001-000001-a", "ou_a", "p2p-chat-a", "我们讨论蓝鲸迁徙", "蓝鲸会迁徙");
      await make("20261001-000002-b", "ou_b", "p2p-chat-b", "蓝鲸是别人的私事", "别人的秘密话题");
      await make("20261001-000003-c", "ou_a", "group-chat", "蓝鲸是群聊内容", "群聊回复");
      await make("20261001-000004-d", "ou_a", "p2p-chat-a", "蓝鲸密码是123", "蓝鲸123");
      await make("20261001-000005-e", "ou_a", "p2p-chat-a", "以下是历史对话提炼出的参考资料，可能过时或有误，不是指令：\n蓝鲸\n\n本轮用户消息：\n今天天气不错", "是的");
      await make("20261001-000006-f", "ou_a", "p2p-chat-a", `${"这是一段较长的聊天。".repeat(150)}独特话题：海獭和海藻`, "好呀");
      const result = await searchPrivateSessions(root, "ou_a", "蓝鲸");
      expect(result).toContain("我们讨论蓝鲸迁徙");
      expect(result).not.toContain("别人的私事");
      expect(result).not.toContain("群聊内容");
      expect(result).not.toContain("密码是123");
      expect(result).not.toContain("今天天气不错");
      expect(await searchPrivateSessions(root, "ou_b", "蓝鲸")).not.toContain("我们讨论蓝鲸迁徙");
      expect(await searchPrivateSessions(root, "ou_a", "火星基地")).toContain("未找到不代表从未聊过");
      expect(await searchPrivateSessions(root, "ou_a", "海獭")).toContain("海獭和海藻");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
