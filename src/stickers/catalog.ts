/**
 * 表情包目录、归一化与检索。
 *
 * 打分算法（字段权重 / CJK bigram 回退 / 多词覆盖率惩罚 / 近分抖动）移植自
 * dsh-nekowhale-stickers（Apache-2.0）：
 *   https://github.com/Loping151/dsh-nekowhale-stickers/blob/main/src/core/search.ts
 * 知识数据（tags / meme / desc）来自同仓库 meta/，CC BY-NC 4.0，
 * 署名与授权要求见 stickers/nekowhale/{NOTICE,LICENSE-ASSETS}。
 *
 * dsh-pet 包的素材与动作描述来自 https://github.com/PC2005-cloud/dsh-pet
 * （代码 MIT，素材禁止商用；宠物形象 CC BY-NC-SA 4.0，详见 stickers/dsh-pet/NOTICE）。
 */
import { access, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { logger } from "../utils/logger.ts";
import { applyRules, EMPTY_RULES, type StickerRules } from "./rules.ts";
import { recentSent, sentPenalty } from "./recent.ts";
import { readStickerNote, type StickerNote } from "./notes.ts";
import { REPLY_TERMS, type StickerReply } from "./reply-intent.ts";

export interface Sticker {
  id: string;
  pack: string;
  stem: string;
  code: string;
  group: string;
  name: string;
  emotion: string;
  tags: string[];
  use: string;
  dir: string;
  text: string;
  meme: string;
  en: string;
  desc: string;
  note?: StickerNote;
  /** 本地绝对路径，只在服务端使用，绝不返回给模型 */
  path: string;
}

export interface SearchOptions {
  reply?: StickerReply;
  pack?: string;
  emotion?: string;
  limit?: number;
  /** 近分抖动，默认开启；测试传 false 或注入固定 random */
  shuffle?: boolean;
  random?: () => number;
  rules?: StickerRules;
  /** 最近发送过的 id，命中则分数打折，避免短时间重复刷同一张 */
  downweight?: readonly string[];
  /** 情景候选只在模型明确选择时启用，不自动发图。 */
  scene?: StickerScene;
}

export const STICKER_SCENES = ["thinking", "working", "waiting", "success", "failure", "resting", "greeting"] as const;
export type StickerScene = (typeof STICKER_SCENES)[number];
const SCENE_IDS: Record<StickerScene, readonly string[]> = {
  thinking: ["gongzuozhuangtai-sikao-maopao", "shendu-sikao-suisuinian"],
  working: ["gongzuozhuangtai-manglu-dianan", "xie-daima", "qingkuai-jilu"],
  waiting: ["gongzuozhuangtai-yuandi-duobu-zhangwang", "dongzhangxiwang"],
  success: ["gongzuozhuangtai-queyue-qingzhu", "dianji-huiying-kaixin-yuedong"],
  failure: ["gongzuozhuangtai-chuitou-tanqi-maohan"],
  resting: ["shuijiao-xunhuan", "yuandi-xiaoqi-chenmian", "haqian-liantian"],
  greeting: ["dianji-huiying-yuanqi-huishou"],
};

type FieldKey = "name" | "tagsJoined" | "emotion" | "text" | "meme" | "use" | "en" | "desc" | "dir";

/** 权重顺序即参考实现的顺序；调参时只改这里 */
const WEIGHTS: Array<[FieldKey, number]> = [
  ["name", 6], ["tagsJoined", 5], ["emotion", 4], ["text", 4],
  ["meme", 3], ["use", 3], ["en", 2], ["desc", 1], ["dir", 2],
];

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u;

const REQUIRED_PACKS = ["nekowhale", "clawd", "whale-girl"] as const;
const OPTIONAL_PACKS = ["bluefish", "emotelab"] as const;
/** 扩展包：metadata 直接写全 Sticker 字段，新增同类来源只需把包名加到这里 */
const EXTRA_PACKS = ["dsh-pet", "chinese-bqb", "emoji-package", "dafeiyu"] as const;
/** 全部包名，工具参数的 pack enum 单一来源，避免多处手写漂移 */
export const ALL_PACKS = [...REQUIRED_PACKS, ...OPTIONAL_PACKS, ...EXTRA_PACKS];

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** 目录解析结果按 metadata 的 mtime + size 缓存，避免每次搜索重新解析 212KB */
let catalogCache: { key: string; items: Sticker[]; checkedAt: number } | undefined;

async function readPack(base: string, pack: string): Promise<Array<Record<string, unknown>>> {
  // 表情是低风险能力：单个包 metadata 缺失或损坏只降级该包（同 rules 的哲学），不拖垮其它包；
  // 缓存 key 含 mtime，文件不变不会重复读取与告警。
  try {
    const raw = JSON.parse(await readFile(join(base, pack, "metadata.json"), "utf8")) as { stickers?: unknown };
    return Array.isArray(raw.stickers) ? raw.stickers as Array<Record<string, unknown>> : [];
  } catch (error) {
    logger.warn(`[Stickers] 读取 ${pack}/metadata.json 失败，跳过该包：`, error instanceof Error ? error.message : error);
    return [];
  }
}

/** 代号前缀（group 规则用）：10N01 → 10N；无字母前缀时退回 code 本身 */
const groupOf = (code: string): string => code.replace(/\d+$/u, "") || code;

export async function loadCatalog(root: string): Promise<Sticker[]> {
  const base = resolve(root);
  const stamps = await Promise.all(ALL_PACKS.map(async (pack) => {
    try {
      const info = await stat(join(base, pack, "metadata.json"));
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return "-";
    }
  }));
  const key = `${base}|${stamps.join("|")}`;
  if (catalogCache?.key === key && Date.now() - catalogCache.checkedAt < 5_000) return catalogCache.items;

  const [fish, clawd, whale, blue, emote, ...extras] = await Promise.all([
    readPack(base, "nekowhale"),
    readPack(base, "clawd"),
    readPack(base, "whale-girl"),
    readPack(base, "bluefish"),
    readPack(base, "emotelab"),
    ...EXTRA_PACKS.map((pack) => readPack(base, pack)),
  ]);

  const items: Sticker[] = [];

  // nekowhale：id = 「套组/代号_名字」，双人套组通过 dir 标明方向
  for (const item of fish) {
    if (typeof item.id !== "string") continue;
    const [folder, stem, ...rest] = item.id.split("/");
    if (!folder || !stem || rest.length !== 0) continue;
    const code = stem.split("_")[0] ?? stem;
    items.push({
      id: `nekowhale:${item.id}`,
      pack: "nekowhale",
      stem,
      code,
      group: groupOf(code),
      name: stem.slice(code.length + 1) || stem,
      emotion: text(item.emotion),
      tags: strings(item.tags),
      use: text(item.use),
      dir: text(item.dir),
      text: text(item.text),
      meme: text(item.meme),
      en: text(item.en),
      desc: text(item.desc),
      path: join(base, "nekowhale", folder, `${stem}.gif`),
    });
  }

  // clawd：gif 与 gif-dark 两套，只收 light
  for (const item of clawd) {
    if (typeof item.id !== "string" || typeof item.light !== "string") continue;
    items.push({
      id: `clawd:${item.id}`,
      pack: "clawd",
      stem: item.id,
      code: item.id,
      group: item.id,
      name: text(item.name) || item.id,
      emotion: text(item.emotion),
      tags: strings(item.tags),
      use: text(item.use),
      dir: text(item.dir),
      text: text(item.text),
      meme: text(item.meme),
      en: text(item.english),
      desc: text(item.desc) || text(item.description),
      path: join(base, "clawd", item.light),
    });
  }

  // whale-girl：只有描述与文件名
  for (const item of whale) {
    if (typeof item.id !== "string" || typeof item.filename !== "string") continue;
    items.push({
      id: `whale-girl:${item.id}`,
      pack: "whale-girl",
      stem: item.id,
      code: item.id,
      group: groupOf(item.id),
      name: text(item.description) || item.id,
      emotion: text(item.emotion),
      tags: strings(item.tags),
      use: text(item.use),
      dir: text(item.dir),
      text: text(item.text),
      meme: text(item.meme),
      en: "",
      desc: text(item.desc) || text(item.description),
      path: join(base, "whale-girl", "gifs", item.filename),
    });
  }

  // bluefish：mood 就是情绪，subject 是描述
  for (const item of blue) {
    if (typeof item.id !== "number" || typeof item.file !== "string") continue;
    const mood = text(item.mood);
    items.push({
      id: `bluefish:${item.id}`,
      pack: "bluefish",
      stem: String(item.id),
      code: String(item.id),
      group: groupOf(String(item.id)),
      // name 不用 mood：否则情绪词全等占用 name 后，pickSticker 的情绪随机会被 exact 分支劫持
      name: text(item.subject) || mood || String(item.id),
      emotion: mood,
      tags: strings(item.tags),
      use: text(item.use),
      dir: text(item.dir),
      text: text(item.text),
      meme: text(item.meme),
      en: "",
      desc: text(item.desc) || text(item.subject),
      path: join(base, "bluefish", item.file),
    });
  }

  // emotelab：只有名字；标签不再塞「大肥鱼」这类固定词，避免污染 tag 过滤
  for (const item of emote) {
    if (typeof item.id !== "number" || typeof item.file !== "string") continue;
    const name = text(item.name) || String(item.id);
    items.push({
      id: `emotelab:${item.id}`,
      pack: "emotelab",
      stem: String(item.id),
      code: String(item.id),
      group: groupOf(String(item.id)),
      name,
      emotion: text(item.emotion),
      tags: strings(item.tags),
      use: text(item.use),
      dir: text(item.dir),
      text: text(item.text),
      meme: text(item.meme),
      en: "",
      desc: text(item.desc) || name,
      path: join(base, "emotelab", item.file),
    });
  }

  // 扩展包（dsh-pet / chinese-bqb / emoji-package）：metadata 直接写全 Sticker 字段；
  // chinese-bqb 与 emoji-package 的字段由目录名+中文文件名派生（见 harvest 脚本）
  for (const [index, raw] of extras.entries()) {
    const pack = EXTRA_PACKS[index];
    if (!pack) continue;
    for (const item of raw) {
      if (typeof item.id !== "string" || typeof item.file !== "string") continue;
      const code = text(item.code) || item.id;
      items.push({
        id: `${pack}:${item.id}`,
        pack,
        stem: code,
        code,
        group: text(item.group),
        name: text(item.name) || item.id,
        emotion: text(item.emotion),
        tags: strings(item.tags),
        use: text(item.use),
        dir: text(item.dir),
        text: text(item.text),
        meme: text(item.meme),
        en: text(item.en),
        desc: text(item.desc),
        path: join(base, pack, item.file),
      });
    }
  }

  // Keep the original metadata too: existing blacklist/content rules must not be erased by a new note.
  let cursor = 0;
  await Promise.all(Array.from({ length: 24 }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      item.note = await readStickerNote(base, item.path);
    }
  }));
  catalogCache = { key, items, checkedAt: Date.now() };
  return items;
}

/** 术语切分：参考实现的分隔符集合 + 最多 10 个词 */
export function terms(query: string): string[] {
  return query.toLowerCase().split(/[\s,，。.!！?？、;；:：/|]+/u).filter(Boolean).slice(0, 10);
}

function bigrams(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < value.length; i++) out.push(value.slice(i, i + 2));
  return out;
}

function fields(item: Sticker): Record<FieldKey, string> {
  return {
    name: item.name.toLowerCase(),
    tagsJoined: [...item.tags, ...(item.note?.tags ?? [])].join(" ").toLowerCase(),
    emotion: [item.emotion, item.note?.emotion].filter(Boolean).join(" ").toLowerCase(),
    text: [item.text, item.note?.text].filter(Boolean).join(" ").toLowerCase(),
    meme: [item.meme, item.note?.meaning].filter(Boolean).join(" ").toLowerCase(),
    use: [item.use, item.note?.use].filter(Boolean).join(" ").toLowerCase(),
    en: item.en.toLowerCase(),
    desc: [item.desc, item.note?.description, item.note?.motion].filter(Boolean).join(" ").toLowerCase(),
    dir: item.dir.toLowerCase(),
  };
}

function score(item: Sticker, queries: string[], cache: Map<string, Record<FieldKey, string>>): number {
  let normalized = cache.get(item.id);
  if (!normalized) {
    normalized = fields(item);
    cache.set(item.id, normalized);
  }
  let total = 0;
  let matched = 0;
  for (const query of queries) {
    let best = 0;
    for (const [key, weight] of WEIGHTS) {
      const value = normalized[key];
      if (!value) continue;
      if (value.includes(query)) {
        best = Math.max(best, weight * (value === query ? 1.5 : 1));
      } else if (CJK.test(query) && query.length > 2) {
        // 整体没命中时用二元组重叠率兜底：「想摸鱼」能找到「摸鱼」
        const pairs = bigrams(query);
        const hit = pairs.filter((pair) => value.includes(pair)).length;
        if (hit) best = Math.max(best, weight * hit / pairs.length * 0.8);
      }
    }
    total += best;
    if (best > 0) matched++;
  }
  // 多词查询优先「每个词都沾边」，而不是被单个强命中的词带偏
  return queries.length > 1 ? total * (matched / queries.length) ** 2 : total;
}

export async function searchStickers(root: string, query: string, opts: SearchOptions = {}): Promise<Sticker[]> {
  const base = resolve(root);
  const rules = opts.rules ?? EMPTY_RULES;
  const items = applyRules(await loadCatalog(base), rules);
  const pack = opts.pack && opts.pack !== "all" ? opts.pack : undefined;
  const pool = items.filter((item) =>
    (!pack || item.pack === pack) && (!opts.emotion || (item.note?.emotion || item.emotion) === opts.emotion));
  const queries = terms(query.slice(0, 200));
  const limit = Math.max(1, Math.min(20, opts.limit ?? 8));
  const random = opts.random ?? Math.random;

  const cache = new Map<string, Record<FieldKey, string>>();
  // Alternatives use max, not an AND-style coverage penalty: a reply need not
  // simultaneously contain "反击、反弹、接招". Prefer actual caption/meaning/use.
  const replyScore = (item: Sticker): number => {
    if (!opts.reply) return 0;
    let value = cache.get(item.id);
    if (!value) { value = fields(item); cache.set(item.id, value); }
    const response = [value.text, value.meme, value.use].join(" ");
    return Math.max(...REPLY_TERMS[opts.reply].map(term =>
      score(item, [term], cache) + (response.includes(term) ? 5 : 0)));
  };
  const hits = opts.scene
    ? pool.filter(item => item.pack === "dsh-pet" && SCENE_IDS[opts.scene!].some(id => item.id === `dsh-pet:anim/${id}`))
      .map(item => ({ item, score: 1 + (queries.length ? score(item, queries, cache) : 0) }))
    : queries.length === 0 && !opts.reply
    // 空 query = 随机挑一张：给随机基础分，否则抖动乘 0 永远是 id 序前 8 张固定面孔
    ? pool.map((item) => ({ item, score: (opts.shuffle ?? true) ? random() : 0 }))
    : pool.map((item) => ({ item, score: opts.reply
        ? replyScore(item) * 1.5 + score(item, queries, cache) * 0.25
        : score(item, queries, cache) })).filter((hit) => hit.score > 0);
  // 最近发送过的降权（空查询也一样生效）
  if (opts.downweight?.length) {
    for (const hit of hits) hit.score *= sentPenalty(hit.item.id, opts.downweight);
  }
  // 近分抖动：避免同一个查询永远返回同一张
  if (opts.shuffle ?? true) for (const hit of hits) hit.score *= 1 + random() * 0.15;
  hits.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id, "zh-CN"));

  const result: Sticker[] = [];
  for (const { item } of hits) {
    const rel = relative(base, resolve(item.path));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    if (!(await access(item.path).then(() => true, () => false))) continue;
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

/** 精确 id / stem / code / 名字 → 命中；否则把情绪词当成「该情绪下随便一张」 */
export async function pickSticker(
  root: string,
  ref: string,
  opts: { pack?: string; rules?: StickerRules; random?: () => number; downweight?: readonly string[] } = {},
): Promise<Sticker | undefined> {
  const items = applyRules(await loadCatalog(resolve(root)), opts.rules ?? EMPTY_RULES);
  const pool = opts.pack && opts.pack !== "all" ? items.filter((item) => item.pack === opts.pack) : items;
  const target = ref.trim();
  if (!target) return undefined;
  const exact = pool.find((item) => item.id === target)
    ?? pool.find((item) => item.stem === target || item.code === target)
    // name 与 emotion 同源的招牌条目不占 exact：模型发「思考」要的是随便一张思考，
    // 不是永远同一张；它们仍在情绪候选里可被随机到
    ?? pool.find((item) => item.name === target && item.name !== item.emotion);
  if (exact) return exact;
  const same = pool.filter((item) => item.emotion === target);
  if (same.length === 0) return undefined;
  // 情绪随机也避开最近发过的（与搜索降权同一份记录）；全发过才回退全池。
  // exact 分支不受影响：用户点名重发必须精确命中。
  const fresh = same.filter((item) => !(opts.downweight ?? recentSent()).includes(item.id));
  const candidates = fresh.length > 0 ? fresh : same;
  return candidates[Math.floor((opts.random ?? Math.random)() * candidates.length)];
}

/** 工具返回用的一行摘要：名字｜情绪｜标签｜方向（空段省略） */
export function stickerLine(item: Sticker): string {
  return [item.name, item.note?.emotion || item.emotion,
    (item.note?.tags ?? item.tags).slice(0, 3).join("/"), item.dir,
    item.note?.meaning ? `含义：${item.note.meaning.slice(0, 80)}` : "",
  ].filter(Boolean).join("｜");
}
