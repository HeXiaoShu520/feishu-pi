import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineTool } from "../../src/tools/sdk.ts";
import { ALL_PACKS, searchStickers, stickerLine } from "../../src/stickers/search.ts";
import { createRulesLoader } from "../../src/stickers/rules.ts";
import { recentSent } from "../../src/stickers/recent.ts";
import { stickerSearchDescription, STICKER_EMPTY_HINT } from "../../src/stickers/description.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../data/stickers");
// 管理员侧检索同样读实时黑白名单；描述里的频率档位在工具加载时固定为默认 normal。
const rules = createRulesLoader(resolve(here, "../../.agent/stickers.json"));

export default defineTool<{ query?: string; pack?: string; emotion?: string; limit?: number }>({
  name: "sticker_search",
  description: stickerSearchDescription("normal"),
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
  execute: async ({ query = "", pack = "all", emotion, limit: raw = 8 }) => {
    const limit = Math.min(Math.max(Math.trunc(raw), 1), 20);
    const results = await searchStickers(root, query, { pack, emotion, limit, rules: await rules(), downweight: recentSent() });
    return results.length
      ? results.map((item) => ({
          id: item.id,
          line: stickerLine(item),
          use: item.use || undefined,
          desc: item.desc && item.desc !== item.name ? item.desc.slice(0, 50) : undefined,
        }))
      : [{ hint: STICKER_EMPTY_HINT }];
  },
});
