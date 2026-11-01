/**
 * 兼容入口：检索实现已迁到 catalog.ts（统一目录 + 加权打分）。
 * 保留本文件，避免 send / guest-search / .agent/tools 的 import 路径大改。
 */
export { searchStickers, pickSticker, stickerLine, loadCatalog, terms, ALL_PACKS } from "./catalog.ts";
export type { Sticker, SearchOptions } from "./catalog.ts";
