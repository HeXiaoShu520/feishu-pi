import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuPiTool } from "../runtime/types.ts";
import { textResult } from "../tools/result.ts";
import { pickSticker, stickerLine } from "./catalog.ts";
import { stickerSendDescription } from "./description.ts";
import { recordSent, type StickerHistory } from "./recent.ts";
import { logger } from "../utils/logger.ts";
import type { StickerGuide, StickerRules } from "./rules.ts";

export interface StickerSendOptions {
  /** 每次发送前读一次黑白名单（内部按 mtime 缓存）；用户配置优先 */
  rules?: () => Promise<StickerRules>;
  /** 启动时读取的使用频率档位，只影响工具描述 */
  guide?: StickerGuide;
  history?: StickerHistory;
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
      properties: {
        id: { type: "string", description: "sticker_search 返回的完整 id，也可以是表情名或情绪词" },
        standalone: { type: "boolean", description: "true = 作为独立图片消息发送；默认 false：只上传并返回 markdown 片段，由你在回复卡片正文里贴出。用户只要图不要文字时用它，此时最终答复可以留空" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (_toolId, params, signal) => {
      signal?.throwIfAborted();
      if (!chatId) throw new Error("当前会话没有飞书聊天 ID，无法发送表情");
      const { id, standalone } = params as { id?: unknown; standalone?: unknown };
      if (typeof id !== "string" || !id.trim() || id.length > 240) throw new Error("需要有效的表情 id");
      const rules = options.rules ? await options.rules() : undefined;
      const recent = options.history ? await options.history.list(chatId).catch(() => []) : [];
      const sticker = await pickSticker(root, id, { rules, downweight: options.history ? recent.map(item => item.id) : undefined });
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
      const meaning = { description: sticker.desc, text: sticker.text, use: sticker.use, direction: sticker.dir, meme: sticker.meme, source: "catalog_metadata" };
      const markRecorded = async () => {
        recordSent(sticker.id);
        if (options.history) await options.history.record(chatId, sticker.id, stickerLine(sticker)).catch(() => logger.warn("[Sticker] 表情已发送，但记录保存失败"));
      };
      if (!standalone) {
        // 默认嵌入回复卡片：飞书 JSON 2.0 markdown 支持 ![hover](image_key)，
        // 片段出现在答复正文即渲染在卡内；不再发独立图片消息。
        // 上传成功不等于卡片已发出；没有卡片回执前不能计入成功发送历史。
        const hover = stickerLine(sticker).replace(/[[\]()]/g, " ");
        return textResult({ embedded: true, sent: false, status: "uploaded_pending_card", imageKey: uploaded.image_key, markdown: `![${hover}](${uploaded.image_key})`, name: sticker.name, id: sticker.id, line: stickerLine(sticker), meaning });
      }
      const sent = await client.im.v1.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "image", content: JSON.stringify({ image_key: uploaded.image_key }) } });
      if (sent.code !== 0 || !sent.data?.message_id) throw new Error(`飞书图片发送失败：${sent.msg ?? sent.code ?? "未返回消息 ID"}`);
      await markRecorded();
      return textResult({ sent: true, name: sticker.name, id: sticker.id, line: stickerLine(sticker), meaning, messageId: sent.data.message_id });
    },
  };
}
