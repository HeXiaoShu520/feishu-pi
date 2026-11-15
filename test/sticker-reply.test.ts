import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchStickers } from "../src/stickers/catalog.ts";
import { createGuestStickerSearchTool } from "../src/stickers/guest-search.ts";
import { EMPTY_RULES } from "../src/stickers/rules.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sticker-reply-"));
  for (const pack of ["nekowhale", "clawd", "whale-girl", "chinese-bqb"]) {
    await mkdir(join(root, pack));
    await writeFile(join(root, pack, "metadata.json"), JSON.stringify({ stickers: [] }));
  }
  const stickers = [
    { id: "reflect", name: "反弹", text: "反弹", meme: "把对方的攻击反弹回去", use: "回应对方的挑衅" },
    { id: "dodge", name: "打不着", text: "打不着", meme: "闪避攻击", use: "躲开对方招式" },
    { id: "surrender", name: "投降", text: "投降", meme: "认输求饶", use: "玩笑式认输" },
    { id: "question", name: "问号", text: "？", emotion: "疑惑", use: "表达疑惑" },
    { id: "welcome", name: "欢迎", text: "欢迎", use: "迎接对方" },
  ].map(item => ({ ...item, file: `${item.id}.png`, desc: item.meme || item.name, tags: [] }));
  await writeFile(join(root, "chinese-bqb", "metadata.json"), JSON.stringify({ stickers }));
  for (const item of stickers) await writeFile(join(root, "chinese-bqb", item.file), "fixture");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("斗图按自己的回应方向选图", () => {
  it.each([["counter", "reflect"], ["dodge", "dodge"], ["surrender", "surrender"], ["welcome", "welcome"]] as const)(
    "%s 能找到对应动作，空query不随机给问号", async (reply, id) => {
      const found = await searchStickers(root, "", { reply, shuffle: false, limit: 1 });
      expect(found[0]?.id).toBe(`chinese-bqb:${id}`);
    });

  it("反击意图优先于来图的疑惑词，不简单镜像对方情绪", async () => {
    const found = await searchStickers(root, "问号 疑惑", { reply: "counter", shuffle: false, limit: 1 });
    expect(found[0]?.id).toBe("chinese-bqb:reflect");
  });

  it("新模式继续遵守黑名单，不能绕过图库规则", async () => {
    const found = await searchStickers(root, "", { reply: "counter", shuffle: false,
      rules: { ...EMPTY_RULES, blacklist: ["chinese-bqb:reflect"] } });
    expect(found.some(item => item.id === "chinese-bqb:reflect")).toBe(false);
  });

  it("公开工具接收回应方向并返回候选文字与含义，不发送图片", async () => {
    const tool = createGuestStickerSearchTool(root);
    const result = await tool.execute("test", { reply: "counter", limit: 1 }, undefined, undefined);
    const payload = JSON.stringify(result);
    expect(payload).toContain("反弹");
    expect(payload).not.toContain(root.replace(/\\/g, "\\\\"));
  });
});
