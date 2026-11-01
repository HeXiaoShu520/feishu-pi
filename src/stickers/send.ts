import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuPiTool } from "../runtime/types.ts";
import { textResult } from "../tools/result.ts";
import { pickSticker, stickerLine } from "./catalog.ts";
import { stickerSendDescription } from "./description.ts";
import type { StickerGuide, StickerRules } from "./rules.ts";

export interface StickerSendOptions {
  /** 每次发送前读一次黑白名单（内部按 mtime 缓存）；用户配置优先 */
  rules?: () => Promise<StickerRules>;
  /** 启动时读取的使用频率档位，只影响工具描述 */
  guide?: StickerGuide;
}

/** Send a catalogued sticker only to the session bound by the runtime. */
export function createStickerSendTool(
  client: Client,
  root: string,
  chatId: string,
  options: StickerSendOptions = {},
): FeishuPiTool {
  return {
    name: "sticker_send", label: "发送表情包",
    description: stickerSendDescription(options.guide ?? "normal"),
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "sticker_search 返回的完整 id，也可以是表情名或情绪词" } },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (_toolId, params, signal) => {
      signal?.throwIfAborted();
      if (!chatId) throw new Error("当前会话没有飞书聊天 ID，无法发送表情");
      const { id } = params as { id?: unknown };
      if (typeof id !== "string" || !id.trim() || id.length > 240) throw new Error("需要有效的表情 id");
      const rules = options.rules ? await options.rules() : undefined;
      const sticker = await pickSticker(root, id, { rules });
      if (!sticker) throw new Error("表情不存在或本地文件不可用，请先搜索");
      const [base, path] = await Promise.all([realpath(root), realpath(sticker.path)]);
      const rel = relative(base, path);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("表情路径超出图库目录");
      const info = await stat(path);
      if (!info.isFile() || info.size === 0 || info.size > 10 * 1024 * 1024) throw new Error("图片不可用或超过 10 MiB");
      const image = await readFile(path);
      if (!(image.subarray(0, 6).toString("ascii").startsWith("GIF8") || image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))) throw new Error("仅支持图库中的 GIF 和 PNG 表情");
      signal?.throwIfAborted();
      const uploaded = await client.im.v1.image.create({ data: { image_type: "message", image } });
      if (!uploaded?.image_key) throw new Error("飞书图片上传失败：未返回 image_key");
      signal?.throwIfAborted();
      const sent = await client.im.v1.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "image", content: JSON.stringify({ image_key: uploaded.image_key }) } });
      if (sent.code !== 0 || !sent.data?.message_id) throw new Error(`飞书图片发送失败：${sent.msg ?? sent.code ?? "未返回消息 ID"}`);
      return textResult({ sent: true, name: sticker.name, id: sticker.id, line: stickerLine(sticker), messageId: sent.data.message_id });
    },
  };
}
