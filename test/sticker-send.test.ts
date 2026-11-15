import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { createStickerSendTool } from "../src/stickers/send.ts";
import { createGuestStickerSearchTool } from "../src/stickers/guest-search.ts";
import { StickerHistory } from "../src/stickers/recent.ts";
import type { StickerPreview } from "../src/stickers/preview.ts";
import type { FeishuPiTool } from "../src/runtime/types.ts";

async function preview(_root: string, path: string): Promise<StickerPreview> {
  return { data: "cHJldmlldw==", mimeType: "image/png", sha256: createHash("sha256").update(await readFile(path)).digest("hex"), frameCount: 2, sampledFrames: [1, 2], durationMs: 200 };
}
async function inspect(tool: FeishuPiTool, id: string): Promise<string> {
  const result = await tool.execute("inspect", { id, action: "inspect" }, undefined, undefined);
  const block = result.content.find(block => block.type === "text");
  const value = JSON.parse(block && block.type === "text" ? block.text : "{}");
  expect(value.sent).toBe(false);
  expect(result.content.some(block => block.type === "image")).toBe(true);
  return value.reviewToken;
}

describe("飞书表情发送", () => {
  it("默认独立发送到绑定会话并记录；standalone:false 只上传嵌卡；拒绝未知 ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "sticker-send-"));
    try {
      for (const dir of ["nekowhale/大肥鱼", "clawd", "whale-girl"]) await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, "nekowhale/metadata.json"), JSON.stringify({ stickers: [{ id: "大肥鱼/开心", tags: ["开心"] }] }));
      await writeFile(join(root, "clawd/metadata.json"), JSON.stringify({ stickers: [] }));
      await writeFile(join(root, "whale-girl/metadata.json"), JSON.stringify({ stickers: [] }));
      await writeFile(join(root, "nekowhale/大肥鱼/开心.gif"), Buffer.from("GIF89a"));
      const upload = vi.fn().mockResolvedValue({ image_key: "img_key" });
      const send = vi.fn().mockResolvedValue({ code: 0, data: { message_id: "message" } });
      const client = { im: { v1: { image: { create: upload }, message: { create: send } } } } as unknown as Client;
      const history = new StickerHistory(join(root, "history"));
      const tool = createStickerSendTool(client, root, "oc_current", { history, preview });
      const found = await createGuestStickerSearchTool(root).execute("call", { query: "开心" }, undefined, undefined);
      expect(JSON.stringify(found)).toContain("nekowhale:大肥鱼/开心");
      expect(JSON.stringify(found)).not.toContain(root);
      const id = "nekowhale:大肥鱼/开心";
      // 先看图，不上传、不发送；没有检查凭证不能直接发送。
      await expect(tool.execute("call", { id, action: "send", reason: "接住开心语气" }, undefined, undefined)).rejects.toThrow("inspect");
      const token = await inspect(tool, id);
      expect(upload).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      await tool.execute("call", { id, action: "send", reviewToken: token, reason: "接住对方轻松开心的语气" }, undefined, undefined);
      expect(upload).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith({ params: { receive_id_type: "chat_id" }, data: { receive_id: "oc_current", msg_type: "image", content: JSON.stringify({ image_key: "img_key" }) } });
      expect((await history.list("oc_current"))[0]).toMatchObject({ id: "nekowhale:大肥鱼/开心" });
      expect(await history.list("oc_other")).toEqual([]);
      // standalone: false：嵌入模式只上传，等待卡片成功回执后才记录。
      await expect(tool.execute("call", { id, action: "send", reviewToken: token, reason: "重复" }, undefined, undefined)).rejects.toThrow("reviewToken");
      await tool.execute("call", { id, action: "send", reviewToken: await inspect(tool, id), reason: "用户要求把刚才的图嵌在卡片内", standalone: false }, undefined, undefined);
      expect(upload).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledOnce();
      expect(await history.list("oc_current")).toHaveLength(1);
      // 路径越界仍拒绝
      await expect(tool.execute("call", { id: "../../secrets" }, undefined, undefined)).rejects.toThrow();
      expect(send).toHaveBeenCalledOnce();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("拒绝无会话发送", async () => {
    const tool = createStickerSendTool({} as Client, ".", "");
    await expect(tool.execute("call", { id: "x" }, undefined, undefined)).rejects.toThrow("聊天 ID");
  });
  it("jpg 表情通过魔数检查上传；非图片字节仍拒绝", async () => {
    const root = await mkdtemp(join(tmpdir(), "sticker-jpg-"));
    try {
      // 中文热梗包大半是 jpg，飞书 image API 原生支持，不用转码
      await mkdir(join(root, "emoji-package/搬砖"), { recursive: true });
      await writeFile(join(root, "emoji-package/metadata.json"), JSON.stringify({
        stickers: [
          { id: "搬砖/今天工地好热，砖头烫手", kind: "meme", file: "搬砖/今天工地好热，砖头烫手.jpg", name: "今天工地好热，砖头烫手" },
          { id: "搬砖/假图", kind: "meme", file: "搬砖/假图.jpg", name: "假图" },
        ],
      }));
      await writeFile(join(root, "emoji-package/搬砖/今天工地好热，砖头烫手.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      await writeFile(join(root, "emoji-package/搬砖/假图.jpg"), Buffer.from("text, not an image"));
      const upload = vi.fn().mockResolvedValue({ image_key: "img_key" });
      const client = { im: { v1: { image: { create: upload }, message: { create: vi.fn() } } } } as unknown as Client;
      const tool = createStickerSendTool(client, root, "oc_current", { preview });
      const id = "emoji-package:搬砖/今天工地好热，砖头烫手";
      await tool.execute("call", { id, action: "send", reviewToken: await inspect(tool, id), reason: "接住对方吐槽工作辛苦的语气", standalone: false }, undefined, undefined);
      expect(upload).toHaveBeenCalledOnce();
      await expect(tool.execute("call", { id: "emoji-package:搬砖/假图", standalone: false }, undefined, undefined)).rejects.toThrow("仅支持");
      expect(upload).toHaveBeenCalledOnce();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("按聊天隔离并持久化成功发送记录", async () => {
    const root = await mkdtemp(join(tmpdir(), "sticker-history-"));
    try {
      const history = new StickerHistory(root);
      await Promise.all([history.record("chat-a", "one", "开心｜笑"), history.record("chat-a", "two", "惊讶"), history.record("chat-b", "other", "加油")]);
      const reopened = new StickerHistory(root);
      expect((await reopened.list("chat-a")).map(item => item.id)).toEqual(["two", "one"]);
      expect((await reopened.list("chat-b")).map(item => item.id)).toEqual(["other"]);
      expect(await reopened.list("chat-c")).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
