import type { FeishuPiTool } from "../runtime/types.ts";
import { textResult } from "../tools/result.ts";
import { ALL_PACKS, searchStickers, stickerLine, STICKER_SCENES, type StickerScene } from "./catalog.ts";
import { stickerSearchDescription, STICKER_EMPTY_HINT } from "./description.ts";
import { recentSent, type StickerHistory } from "./recent.ts";
import type { StickerGuide, StickerRules } from "./rules.ts";
import { STICKER_REPLIES, type StickerReply } from "./reply-intent.ts";

export interface GuestStickerSearchOptions {
  rules?: () => Promise<StickerRules>;
  guide?: StickerGuide;
  history?: StickerHistory;
  chatId?: string;
}

/** Public sticker descriptions only; never return local filesystem paths. */
export function createGuestStickerSearchTool(root: string, options: GuestStickerSearchOptions = {}): FeishuPiTool {
  return {
    name: "sticker_search", label: "搜索表情包",
    description: stickerSearchDescription(options.guide ?? "normal"),
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "情绪或场景关键词，例如 开心、思考、加油、摸鱼" },
        reply: { type: "string", enum: [...STICKER_REPLIES], description: "可选：自己这次要表达的接话方向；counter反击、dodge闪避、surrender认输、tease调侃、welcome迎接、agree赞同、comfort安慰。不是对方情绪。" },
        pack: { type: "string", enum: ["all", ...ALL_PACKS] },
        emotion: { type: "string", description: "可选：精确限定情绪，例如 开心、嘲讽、安慰" },
        scene: { type: "string", enum: [...STICKER_SCENES], description: "可选：按真实上下文选择大肥鱼动作场景" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
    execute: async (_id, args, signal) => {
      signal?.throwIfAborted();
      const input = args as { query?: unknown; reply?: unknown; pack?: unknown; emotion?: unknown; scene?: unknown; limit?: unknown };
      const reply = typeof input.reply === "string" && (STICKER_REPLIES as readonly string[]).includes(input.reply)
        ? input.reply as StickerReply : undefined;
      const query = typeof input.query === "string" ? input.query.slice(0, 200) : "";
      const pack = typeof input.pack === "string" ? input.pack : "all";
      const emotion = typeof input.emotion === "string" ? input.emotion : undefined;
      const raw = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : 8;
      const limit = Math.min(Math.max(Math.trunc(raw), 1), 20);
      const rules = options.rules ? await options.rules() : undefined;
      const recent = options.history && options.chatId ? await options.history.list(options.chatId).catch(() => []) : undefined;
      const scene = typeof input.scene === "string" && (STICKER_SCENES as readonly string[]).includes(input.scene) ? input.scene as StickerScene : undefined;
      const results = await searchStickers(root, query, { pack, emotion, reply, scene, limit, rules, downweight: recent ? recent.map(item => item.id) : recentSent() });
      return textResult(results.length
        ? results.map((item) => ({
            id: item.id,
            line: stickerLine(item),
            use: item.note?.use || item.use || undefined,
            emotion: item.note?.emotion || item.emotion || undefined,
            tags: item.note?.tags ?? item.tags,
            desc: item.note?.description || item.desc || undefined,
            motion: item.note?.motion,
            text: item.note?.text || item.text || undefined,
            meaning: item.note?.meaning || item.meme || undefined,
            suitable: item.note?.use || item.use || undefined,
            unsuitable: item.note?.avoid,
            uncertainty: item.note?.uncertainty,
            source: item.note ? "image_description_file" : "catalog_metadata_unverified",
          }))
        : [{ hint: STICKER_EMPTY_HINT }]);
    },
  };
}
