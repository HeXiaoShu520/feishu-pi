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

/** matchesRule 与内置内容安全扫描只需要这些字段，避免 rules 反向依赖 catalog */
export interface RuleTarget {
  id: string;
  stem: string;
  code: string;
  group: string;
  name: string;
  pack: string;
  tags: string[];
  emotion: string;
  /** 可选文本字段（catalog 的 Sticker 自带）：一并参与内置违禁词扫描 */
  text?: string;
  meme?: string;
  desc?: string;
  use?: string;
  note?: { description: string; motion: string; text: string; meaning: string; emotion: string; tags: string[]; use: string };
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
    case "tag": return item.tags.includes(value) || !!item.note?.tags.includes(value);
    case "emotion": return item.emotion === value || item.note?.emotion === value;
      case "group": return item.group === value;
      default: return item.code === value;
    }
  }
  return trimmed === item.id || trimmed === item.stem || trimmed === item.code || trimmed === item.name;
}

/**
 * 内置内容安全过滤：色情与极脏辱骂的表情一律不进检索/发送候选。
 *
 * 与用户黑白名单（可配置、可清空）不同，这层是代码兜底、始终生效——
 * 白名单也不能把违禁表情拉回来。表情库来自公开素材，不能假设每张图都干净。
 *
 * 口径只收「露骨性内容 + 极脏辱骂」；卧槽 / 妈的 / 尼玛 等常见粗口不在此列，
 * 避免把斗图常用的正常素材一并拦掉。子串匹配已避开常见误伤：
 * 用「操你」而不是「操」（节操 / 操作），用「妈逼」而不是「逼」（逼真）。
 */
/** 中文违禁词：中文无词边界，用组合词做子串匹配；“裸”只认露骨组合，避开「裸辞」等正常词 */
const UNSAFE_CJK = [
  // 露骨性内容
  "操死", "操逼", "干你", "草你", "鸡巴", "屌", "屄", "逼水",
  "约炮", "做爱",
  "裸照", "裸身", "全裸", "半裸", "赤裸", "裸露", "裸奔", "裸体", "裸男", "裸女",
  // 极脏辱骂
  "傻逼", "傻b", "煞笔", "沙比", "你妈死", "妈逼", "狗日的",
  "婊子", "贱人", "贱货", "骚货", "骚逼",
];

/**
 * 会与正常词跨词重叠的两字词用负向后瞻收窄：
 * 节「操你」要哪个、血「色情」人节、生「日你」日、个「性爱」好、个「性交」友
 */
const UNSAFE_LOOKBEHIND = /(?<!节)操你|(?<!血)色情|(?<!生)日你|(?<!个)性爱|(?<!个)性交/u;

/** 英文脏话/缩写：按词边界匹配，避免误伤拼音（wu-shitou 的 shitou）与英文单词（subtle 的 sb） */
const UNSAFE_LATIN = /\b(?:fuck|bitch|shit|porn|cnm|nmsl|sb)\b/u;

/** 名字/代号/标签/描述任一字段命中违禁词，即视为不安全（供 applyRules 兜底过滤） */
export function isUnsafeSticker(item: RuleTarget): boolean {
  const haystack = [
    item.name, item.code, item.stem, item.emotion,
    item.desc, item.meme, item.text, item.use, ...item.tags,
    item.note?.description, item.note?.motion, item.note?.text, item.note?.meaning,
    item.note?.emotion, ...(item.note?.tags ?? []), item.note?.use,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n")
    .toLowerCase();
  return UNSAFE_CJK.some((term) => haystack.includes(term))
    || UNSAFE_LOOKBEHIND.test(haystack)
    || UNSAFE_LATIN.test(haystack);
}

/**
 * 内容安全过滤优先于用户名单：违禁表情一律剔除（白名单也救不回来）；
 * 黑名单任一命中即剔除，白名单非空时只保留命中项。
 */
export function applyRules<T extends RuleTarget>(items: T[], rules: StickerRules): T[] {
  return items.filter((item) =>
    !isUnsafeSticker(item)
    && !rules.blacklist.some((rule) => matchesRule(rule, item))
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
