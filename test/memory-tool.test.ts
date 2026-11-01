import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTool } from "../src/feishu/memory-tool.ts";

/** 以指定调用者身份执行一次 memory 工具 */
async function run(tool: ReturnType<typeof createMemoryTool>, openId: string, params: Record<string, unknown>) {
  const result = await tool.execute("t", { ...params, _caller: { openId, chatId: "oc_x" } });
  return result.content.map((c) => (c as { type: string; text?: string }).text ?? "").join("\n");
}

describe("memory 工具（单人长期记忆）", () => {
  it("append 后 read 能看到；rewrite 覆盖；空 rewrite 拒绝", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-"));
    const tool = createMemoryTool({ memoryDir: dir });

    const first = await run(tool, "ou_a", { action: "read" });
    expect(first).toContain("暂无长期记忆");

    await run(tool, "ou_a", { action: "append", text: "喜欢简洁的回复" });
    const after = await run(tool, "ou_a", { action: "read" });
    expect(after).toContain("喜欢简洁的回复");

    await run(tool, "ou_a", { action: "rewrite", text: "整理后的单条记忆" });
    const rewritten = await run(tool, "ou_a", { action: "read" });
    expect(rewritten).toContain("整理后的单条记忆");
    expect(rewritten).not.toContain("喜欢简洁的回复");

    await expect(run(tool, "ou_a", { action: "rewrite", text: "  " })).rejects.toThrow("记忆内容不能为空");

    const file = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(file).toContain("整理后的单条记忆");
  });

  it("不同前端身份参数共用一份个人记忆", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-iso-"));
    const tool = createMemoryTool({ memoryDir: dir });

    await run(tool, "ou_a", { action: "append", text: "A 的秘密" });
    await run(tool, "ou_b", { action: "append", text: "B 的偏好" });

    const seenByB = await run(tool, "ou_b", { action: "read" });
    expect(seenByB).toContain("B 的偏好");
    expect(seenByB).toContain("A 的秘密");

    const seenByA = await run(tool, "ou_a", { action: "read" });
    expect(seenByA).toContain("A 的秘密");
    expect(seenByA).toContain("B 的偏好");
  });

  it("记忆不依赖模型提供身份参数", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-nocaller-"));
    const tool = createMemoryTool({ memoryDir: dir });
    const result = await tool.execute("t", { action: "read" });
    expect(JSON.stringify(result)).toContain("暂无长期记忆");
  });
});
