import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { createStickerSendTool } from "../src/stickers/send.ts";
import { createGuestStickerSearchTool } from "../src/stickers/guest-search.ts";
import { StickerHistory } from "../src/stickers/recent.ts";

describe("飞书表情发送", () => {
  it("嵌入模式只上传不发独立消息；standalone 只发到绑定会话，拒绝未知 ID", async () => {
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
      const tool = createStickerSendTool(client, root, "oc_current", { history });
      const found = await createGuestStickerSearchTool(root).execute("call", { query: "开心" }, undefined, undefined);
      expect(JSON.stringify(found)).toContain("nekowhale:大肥鱼/开心");
      expect(JSON.stringify(found)).not.toContain(root);
      // 默认嵌入模式：只上传，等待卡片成功回执后才记录。
      await tool.execute("call", { id: "nekowhale:大肥鱼/开心" }, undefined, undefined);
      expect(upload).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
      expect(await history.list("oc_current")).toEqual([]);
      expect(await history.list("oc_other")).toEqual([]);
      // standalone：发图，且只发到绑定会话
      await tool.execute("call", { id: "nekowhale:大肥鱼/开心", standalone: true }, undefined, undefined);
      expect((await history.list("oc_current"))[0]).toMatchObject({ id: "nekowhale:大肥鱼/开心" });
      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith({ params: { receive_id_type: "chat_id" }, data: { receive_id: "oc_current", msg_type: "image", content: JSON.stringify({ image_key: "img_key" }) } });
      await expect(tool.execute("call", { id: "../../secrets", standalone: true }, undefined, undefined)).rejects.toThrow();
      expect(send).toHaveBeenCalledOnce();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("拒绝无会话发送", async () => {
    const tool = createStickerSendTool({} as Client, ".", "");
    await expect(tool.execute("call", { id: "x" }, undefined, undefined)).rejects.toThrow("聊天 ID");
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
