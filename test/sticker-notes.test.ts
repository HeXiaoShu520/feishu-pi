import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { parseStickerNote, readStickerNote } from "../src/stickers/notes.ts";
import { createGuestStickerSearchTool } from "../src/stickers/guest-search.ts";
import { createStickerSendTool } from "../src/stickers/send.ts";
import { EMPTY_RULES } from "../src/stickers/rules.ts";

const roots: string[] = [];
const bytes = Buffer.from("GIF89a fixture");
const hash = createHash("sha256").update(bytes).digest("hex");
function note(file: string, meaning = "这是自嘲自己卡住了，不是在骂对方") {
  return `图片文件：${basename(file)}\n画面：蓝色角色双手捧脸，眼睛转圈，头顶冒出问号。\n动作：左右摇晃\n图中文字：我是谁\n表达含义：${meaning}\n情绪：困惑\n关键词：问号、困惑、自嘲\n适合接话：对方的问题太难，自己一时没想明白\n不适合：对方认真求安慰时\n不确定处：无\n描述来源：测试视觉标注\n图片SHA256：${hash}\n`;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sticker-notes-")); roots.push(root);
  await mkdir(join(root, "emotelab"));
  await writeFile(join(root, "emotelab/metadata.json"), JSON.stringify({ stickers: [{ id: 1, name: "Bug", file: "one.gif" }, { id: 2, name: "Other", file: "two.gif" }] }));
  const one = join(root, "emotelab/one.gif"), two = join(root, "emotelab/two.gif");
  await writeFile(one, bytes); await writeFile(two, bytes);
  await writeFile(join(root, "emotelab/one.txt"), note(one));
  return { root, one, two };
}
const parseResult = (result: { content: unknown[] }) => JSON.parse((result.content[0] as { text: string }).text);
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("每张图片的独立描述", () => {
  it("同名不同格式优先读取扩展名限定的描述，不串图；文件名绑定和长度检查", async () => {
    const { root, one } = await fixture();
    await writeFile(`${one}.txt`, note(one, "精确 GIF 的含义"));
    expect((await readStickerNote(root, one))?.meaning).toBe("精确 GIF 的含义");
    expect(parseStickerNote(note("one.jpg"), one)).toBeUndefined();
    expect(parseStickerNote(note(one).replace(/表达含义：[^\n]*\n/, ""), one)).toBeUndefined();
    expect(parseStickerNote("x".repeat(16_001), one)).toBeUndefined();
    expect((await readStickerNote(root, one))?.source).toBe("测试视觉标注");
  });

  it("描述参与搜索，模型得到完整含义、图中文字及不适合情境，不暴露路径", async () => {
    const { root } = await fixture();
    const search = createGuestStickerSearchTool(root);
    const result = await search.execute("q", { query: "自嘲", emotion: "困惑" }, undefined);
    const [candidate] = parseResult(result);
    expect(candidate).toMatchObject({ id: "emotelab:1", text: "我是谁", meaning: "这是自嘲自己卡住了，不是在骂对方", unsuitable: "对方认真求安慰时", source: "image_description_file" });
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("不读取通过目录链接逃出图库的描述文件", async () => {
    const { root } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "sticker-outside-")); roots.push(outside);
    await writeFile(join(outside, "secret.txt"), note("secret.gif"));
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(await readStickerNote(root, join(root, "linked/secret.gif"))).toBeUndefined();
  });

  it("发送必须检查同一图，凭证不能跨会话、换图、过期或在图片/描述修改后复用", async () => {
    const { root, one } = await fixture();
    const upload = vi.fn().mockResolvedValue({ image_key: "image" });
    const send = vi.fn().mockResolvedValue({ code: 0, data: { message_id: "message" } });
    const client = { im: { v1: { image: { create: upload }, message: { create: send } } } } as unknown as Client;
    const preview = async (_root: string, path: string) => ({ data: "cHJldmlldw==", mimeType: "image/png" as const, sha256: createHash("sha256").update(await readFile(path)).digest("hex"), frameCount: 1, sampledFrames: [1], durationMs: 0 });
    const first = createStickerSendTool(client, root, "chat-a", { preview });
    const other = createStickerSendTool(client, root, "chat-b", { preview });
    const inspect = async () => {
      const result = parseResult(await first.execute("i", { id: "emotelab:1" }, undefined));
      expect(result.meaning.source).toBe("image_description_file");
      return result.reviewToken as string;
    };
    const payload = (token: string) => ({ id: "emotelab:1", action: "send", reviewToken: token, reason: "对方刚问了难题，这张自嘲图是在说自己没想明白" });
    const token = await inspect();
    expect(upload).not.toHaveBeenCalled();
    await expect(other.execute("s", payload(token), undefined)).rejects.toThrow("inspect");
    await expect(first.execute("s", { ...payload(token), id: "emotelab:2" }, undefined)).rejects.toThrow("inspect");
    await expect(first.execute("s", { ...payload(token), reason: "" }, undefined)).rejects.toThrow("为什么适合");
    await expect(first.execute("s", { ...payload(token), id: "Bug" }, undefined)).rejects.toThrow("完整表情 ID");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
    await expect(first.execute("s", payload(token), undefined)).rejects.toThrow("inspect");
    clock.mockRestore();
    const changedImage = await inspect();
    await writeFile(one, Buffer.from("GIF89a changed"));
    await expect(first.execute("s", payload(changedImage), undefined)).rejects.toThrow("inspect");
    await writeFile(one, bytes);
    const timestamp = new Date("2026-01-01T00:00:00Z");
    await utimes(join(root, "emotelab/one.txt"), timestamp, timestamp);
    const changedNote = await inspect();
    await writeFile(join(root, "emotelab/one.txt"), note(one, "描述已经更正，现在表达的是另一种意思"));
    await utimes(join(root, "emotelab/one.txt"), timestamp, timestamp);
    await expect(first.execute("s", payload(changedNote), undefined)).rejects.toThrow("inspect");
    expect(send).not.toHaveBeenCalled();
    const accepted = await inspect();
    await first.execute("s", payload(accepted), undefined);
    await expect(first.execute("s", payload(accepted), undefined)).rejects.toThrow("inspect");
    expect(send).toHaveBeenCalledOnce();
  });

  it("检查后修改黑名单仍然阻止发送；预览失败不会上传", async () => {
    const { root } = await fixture();
    const upload = vi.fn();
    const client = { im: { v1: { image: { create: upload } } } } as unknown as Client;
    let blacklist: string[] = [];
    const preview = vi.fn().mockResolvedValue({ data: "cA==", mimeType: "image/png", sha256: hash, frameCount: 1, sampledFrames: [1], durationMs: 0 });
    const tool = createStickerSendTool(client, root, "chat", { preview, rules: async () => ({ ...EMPTY_RULES, blacklist }) });
    const token = parseResult(await tool.execute("i", { id: "emotelab:1" }, undefined)).reviewToken;
    blacklist = ["emotelab:1"];
    await expect(tool.execute("s", { id: "emotelab:1", action: "send", reviewToken: token, reason: "接话" }, undefined)).rejects.toThrow();
    blacklist = [];
    preview.mockRejectedValue(new Error("decode failed"));
    await expect(tool.execute("i", { id: "emotelab:1" }, undefined)).rejects.toThrow("decode failed");
    expect(upload).not.toHaveBeenCalled();
  });
});
