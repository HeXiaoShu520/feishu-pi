/**
 * 表情包黑白名单：用户配置优先，模型不可改（没有任何写接口）。
 *
 * 规则语法对齐 dsh-nekowhale-stickers 的 matchesRule（Apache-2.0）：
 * - `pack:` / `tag:` / `emotion:` / `group:` / `code:` 前缀
 * - 无前缀时精确匹配 id / stem / name / code
 */
import { readFile, stat } from "node:fs/promises";
import { logger } from "../utils/logger.ts";

/** 表情使用频率档位，只影响工具描述里的措辞，不改变工具能力 */
export type StickerGuide = "rare" | "normal" | "often";

export interface StickerRules {
  blacklist: string[];
  whitelist: string[];
  guide: StickerGuide;
}

export const EMPTY_RULES: StickerRules = { blacklist: [], whitelist: [], guide: "normal" };

/** matchesRule 只需要这些字段，避免 rules 反向依赖 catalog */
export interface RuleTarget {
  id: string;
  stem: string;
  code: string;
  group: string;
  name: string;
  pack: string;
  tags: string[];
  emotion: string;
}

const PREFIX = /^(pack|tag|emotion|group|code):(.+)$/u;

export function matchesRule(rule: string, item: RuleTarget): boolean {
  const trimmed = rule.trim();
  if (!trimmed) return false;
  const prefixed = PREFIX.exec(trimmed);
  if (prefixed) {
    const value = prefixed[2].trim();
    switch (prefixed[1]) {
      case "pack": return item.pack === value;
      case "tag": return item.tags.includes(value);
      case "emotion": return item.emotion === value;
      case "group": return item.group === value;
      default: return item.code === value;
    }
  }
  return trimmed === item.id || trimmed === item.stem || trimmed === item.code || trimmed === item.name;
}

/** 黑名单任一命中即剔除；白名单非空时只保留命中项 */
export function applyRules<T extends RuleTarget>(items: T[], rules: StickerRules): T[] {
  return items.filter((item) =>
    !rules.blacklist.some((rule) => matchesRule(rule, item))
    && (rules.whitelist.length === 0 || rules.whitelist.some((rule) => matchesRule(rule, item))));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function guideOf(value: unknown): StickerGuide {
  return value === "rare" || value === "often" ? value : "normal";
}

/**
 * 按 mtime + size 缓存的配置读取器。
 * 文件缺失或损坏时退回空名单并只告警一次：表情是低风险能力，
 * 不像 permissions.json 那样 fail-safe 到"全部拒绝"。
 */
export function createRulesLoader(file: string): () => Promise<StickerRules> {
  let cacheKey = "";
  let cached = EMPTY_RULES;
  let warned = false;
  return async () => {
    try {
      const info = await stat(file);
      const key = `${info.mtimeMs}:${info.size}`;
      if (key === cacheKey) return cached;
      const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      cached = {
        blacklist: stringList(raw.blacklist),
        whitelist: stringList(raw.whitelist),
        guide: guideOf(raw.guide),
      };
      cacheKey = key;
      warned = false;
      return cached;
    } catch (error) {
      if (!warned) {
        warned = true;
        logger.warn(`[Stickers] 无法读取 ${file}，按空名单继续：`, error instanceof Error ? error.message : error);
      }
      return EMPTY_RULES;
    }
  };
}
