import type { FeishuPiTool } from "../runtime/types.ts";
import { textResult } from "../tools/result.ts";
import { ALL_PACKS, searchStickers, stickerLine } from "./catalog.ts";
import { stickerSearchDescription, STICKER_EMPTY_HINT } from "./description.ts";
import type { StickerGuide, StickerRules } from "./rules.ts";

export interface GuestStickerSearchOptions {
  rules?: () => Promise<StickerRules>;
  guide?: StickerGuide;
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
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
    execute: async (_id, args, signal) => {
      signal?.throwIfAborted();
      const input = args as { query?: unknown; pack?: unknown; emotion?: unknown; limit?: unknown };
      const query = typeof input.query === "string" ? input.query.slice(0, 200) : "";
      const pack = typeof input.pack === "string" ? input.pack : "all";
      const emotion = typeof input.emotion === "string" ? input.emotion : undefined;
      const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : 8;
      const rules = options.rules ? await options.rules() : undefined;
      const results = await searchStickers(root, query, { pack, emotion, limit, rules });
      return textResult(results.length
        ? results.map((item) => ({ id: item.id, line: stickerLine(item), use: item.use || undefined }))
        : [{ hint: STICKER_EMPTY_HINT }]);
    },
  };
}
