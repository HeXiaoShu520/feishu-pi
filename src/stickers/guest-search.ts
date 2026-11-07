import type { FeishuPiTool } from "../runtime/types.ts";
import { textResult } from "../tools/result.ts";
import { ALL_PACKS, searchStickers, stickerLine, STICKER_SCENES, type StickerScene } from "./catalog.ts";
import { stickerSearchDescription, STICKER_EMPTY_HINT } from "./description.ts";
import { recentSent, type StickerHistory } from "./recent.ts";
import type { StickerGuide, StickerRules } from "./rules.ts";

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
        pack: { type: "string", enum: ["all", ...ALL_PACKS] },
        emotion: { type: "string", description: "可选：精确限定情绪，例如 开心、嘲讽、安慰" },
        scene: { type: "string", enum: [...STICKER_SCENES], description: "可选：按真实上下文选择大肥鱼动作场景" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
    execute: async (_id, args, signal) => {
      signal?.throwIfAborted();
      const input = args as { query?: unknown; pack?: unknown; emotion?: unknown; scene?: unknown; limit?: unknown };
      const query = typeof input.query === "string" ? input.query.slice(0, 200) : "";
      const pack = typeof input.pack === "string" ? input.pack : "all";
      const emotion = typeof input.emotion === "string" ? input.emotion : undefined;
      const raw = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : 8;
      const limit = Math.min(Math.max(Math.trunc(raw), 1), 20);
      const rules = options.rules ? await options.rules() : undefined;
      const recent = options.history && options.chatId ? await options.history.list(options.chatId).catch(() => []) : undefined;
      const scene = typeof input.scene === "string" && (STICKER_SCENES as readonly string[]).includes(input.scene) ? input.scene as StickerScene : undefined;
      const results = await searchStickers(root, query, { pack, emotion, scene, limit, rules, downweight: recent ? recent.map(item => item.id) : recentSent() });
      return textResult(results.length
        ? results.map((item) => ({
            id: item.id,
            line: stickerLine(item),
            use: item.use || undefined,
            desc: item.desc && item.desc !== item.name ? item.desc.slice(0, 50) : undefined,
          }))
        : [{ hint: STICKER_EMPTY_HINT }]);
    },
  };
}
