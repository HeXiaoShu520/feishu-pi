import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { createStickerSendTool } from "../src/stickers/send.ts";
import { createGuestStickerSearchTool } from "../src/stickers/guest-search.ts";

describe("飞书表情发送", () => {
  it("上传图库图片并只发到绑定会话，拒绝未知 ID", async () => {
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
      const tool = createStickerSendTool(client, root, "oc_current");
      const found = await createGuestStickerSearchTool(root).execute("call", { query: "开心" }, undefined, undefined);
      expect(JSON.stringify(found)).toContain("nekowhale:大肥鱼/开心");
      expect(JSON.stringify(found)).not.toContain(root);
      await tool.execute("call", { id: "nekowhale:大肥鱼/开心" }, undefined, undefined);
      expect(upload).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith({ params: { receive_id_type: "chat_id" }, data: { receive_id: "oc_current", msg_type: "image", content: JSON.stringify({ image_key: "img_key" }) } });
      await expect(tool.execute("call", { id: "../../secrets" }, undefined, undefined)).rejects.toThrow();
      expect(send).toHaveBeenCalledOnce();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("拒绝无会话发送", async () => {
    const tool = createStickerSendTool({} as Client, ".", "");
    await expect(tool.execute("call", { id: "x" }, undefined, undefined)).rejects.toThrow("聊天 ID");
  });
});
