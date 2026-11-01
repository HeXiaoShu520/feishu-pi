/**
 * 从 dsh-pet 上游仓库生成表情包索引（一次性工具，需要时重跑即可）。
 *
 * 输入：上游仓库浅克隆目录
 *   git clone --depth 1 https://github.com/PC2005-cloud/dsh-pet.git <上游根>
 * 输出：<目标目录>/memes/*.png、<目标目录>/anim/*.gif、<目标目录>/metadata.json
 *
 * 素材只用上游 `assets/preview/` 的官方 GIF 预览（220px / 12fps / 保留透明），
 * 不重新编码；名字、分类、用途取自 `assets/config.jsonc`，描述取自 `prompts/` 的动作提示词。
 *
 * 用法：node tools/build-dsh-pet.mjs <上游仓库根> <目标目录，如 data/stickers/dsh-pet>
 */
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [SRC, DEST] = process.argv.slice(2);
if (!SRC || !DEST) throw new Error("用法: node tools/build-dsh-pet.mjs <上游仓库根> <目标目录>");
const ASSETS = join(SRC, "dsh-pet", "assets");

/** JSONC → JSON：处理 // 与 /* *\/ 注释，字符串内的斜杠不动 */
function stripJsonc(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const cfg = JSON.parse(stripJsonc(readFileSync(join(ASSETS, "config.jsonc"), "utf8")));

// 上游 scripts/encode_preview_gifs.py 的 PINYIN 表：动画中文名 → 预览 GIF 文件名
const pyText = readFileSync(join(SRC, "scripts", "encode_preview_gifs.py"), "utf8");
const pyBlock = pyText.slice(pyText.indexOf("PINYIN = {"), pyText.indexOf("\n}\n", pyText.indexOf("PINYIN = {")));
const PINYIN = new Map();
for (const m of pyBlock.matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)) PINYIN.set(m[1], m[2]);

// 动作提示词：每个 ## 标题下的「动作概述」正文，作为语义描述（常规动作与睡觉动作分两份）
const promptMap = new Map();
for (const file of ["桌面宠物 10 秒动作提示词.md", "睡觉动作提示词.md"]) {
  const mdText = readFileSync(join(SRC, "prompts", file), "utf8");
  for (const section of mdText.split(/^## /m).slice(1)) {
    const lines = section.split(/\r?\n/);
    const name = (lines[0] ?? "").trim();
    const at = lines.findIndex((line) => line.includes("动作概述"));
    if (!name || at < 0) continue;
    const body = lines.slice(at + 1).join("\n").split("**按秒")[0];
    promptMap.set(name, body);
  }
}

const TEMPLATE = /(Q版蓝发女仆|全程原地[^。]*。|双脚锚定原点[^。]*。|均在画幅安全区内[^。]*。|X\/Y ?轴锁定[^。]*。|画幅安全区内[^。]*。)/g;
const clean = (value) => value.replace(/\*\*/g, "").replace(TEMPLATE, "").replace(/\s+/g, " ").trim();

/** 情绪保守推断：只在名字/描述明确出现关键词时标注（顺序即优先级，取第一个命中的），宁缺勿错 */
const EMOTION_RULES = [
  ["开心", ["开心", "雀跃", "庆祝", "元气", "跃动", "咯咯笑", "欢呼"]],
  ["生气", ["生气", "气急败坏", "傲娇", "骂他", "发飙"]],
  ["害羞", ["害羞"]],
  ["惊讶", ["惊讶", "吓一跳", "被吓"]],
  ["无语", ["无语", "死鱼眼", "哦鲸鲸", "敷衍"]],
  ["疲惫", ["睡觉", "睡眠", "沉眠", "小憩", "打盹", "瞌睡", "哈欠", "累", "瘫", "叹气", "垂头"]],
  ["卖萌", ["卖萌", "萌化", "比耶"]],
  ["搞怪", ["搞怪", "调皮"]],
  ["难过", ["委屈", "眼泪", "泛泪"]],
];

/** 常见口语同义：源文本命中左列任一词时，把右列补进 tags，弥补短查询与不同叫法 */
const SYNONYMS = [
  [["晚饭"], ["晚餐", "吃饭"]],
  [["午饭"], ["午餐", "吃饭"]],
  [["早饭"], ["早餐", "吃饭"]],
  [["晚餐"], ["晚饭", "吃饭"]],
  [["午餐"], ["午饭", "吃饭"]],
  [["早餐"], ["早饭", "吃饭"]],
  [["吃白饭"], ["吃饭", "蹭饭"]],
  [["睡觉", "沉眠", "打盹", "瞌睡"], ["午睡", "午觉", "休息", "困", "困了"]],
  [["被夸", "点赞"], ["表扬"]],
  [["摸鱼"], ["偷懒"]],
];

const emotionOf = (item) => {
  const text = `${item.name} ${item.desc} ${item.use}`.toLowerCase();
  for (const [emotion, words] of EMOTION_RULES) {
    if (words.some((word) => text.includes(word))) return emotion;
  }
  return "";
};

const extraTagsOf = (item) => {
  const text = `${item.name} ${item.desc} ${item.use}`.toLowerCase();
  const out = [];
  for (const [words, synonyms] of SYNONYMS) {
    if (words.some((word) => text.includes(word))) out.push(...synonyms);
  }
  return out;
};

/** tag 只留短词：与 name 全等的项（无分隔符动作名）去掉，name 本身权重更高 */
const dedupeTags = (raw, name) => [...new Set(raw.filter((tag) => tag && tag !== name))].slice(0, 10);

// 动作名 → { group, use }
const groupOfAction = new Map();
const assign = (names, group, use) => {
  for (const name of [].concat(names)) {
    if (typeof name === "string" && name) groupOfAction.set(name, { group, use });
  }
};
const anim = cfg.animations ?? {};
assign(anim.idle, "待机", "长时间没动作时的呼吸待机");
assign(anim.turn, "转向", "转向时翻转朝向");
assign(anim.drag, "拖拽", "被拖拽悬空时的姿势");
assign(anim.clicks, "点击回应", "被点按时的俏皮回应");
assign((anim.moves?.actions ?? []).map((entry) => entry?.name), "移动", "在桌面上走动或原地踏步");
for (const category of anim.categories ?? []) assign(category.actions, category.id, "");
assign(anim.events?.balance, "余额", "余额百分比档位动画");
assign(anim.events?.whisper, "碎碎念", "碎碎念时配合说话的小动作");
const WORK_STATUS = ["思考中", "调用工具", "整理结果", "等待批准", "完成", "出错"];
(anim.events?.workStatus ?? []).forEach((name, index) => assign(name, "工作状态", `工作状态档位：${WORK_STATUS[index] ?? `第${index}档`}`));
for (const set of anim.sleep ?? []) {
  assign(set?.start, "睡觉", "刚入睡");
  assign(set?.loop, "睡觉", "睡眠循环");
  assign(set?.end, "睡觉", "睡醒起身");
}

const splitTags = (name) => name.split(/[-－———]/u).map((part) => part.trim()).filter(Boolean);

// ---- memes：27 张静态表情 ----
mkdirSync(join(DEST, "memes"), { recursive: true });
mkdirSync(join(DEST, "anim"), { recursive: true });

const memeFiles = new Set(readdirSync(join(ASSETS, "memes")).filter((name) => name.endsWith(".png")));
const stickers = [];
for (const [name, desc] of Object.entries(cfg.memes ?? {})) {
  const file = `${name}.png`;
  if (!memeFiles.has(file)) {
    console.warn(`[skip] 缺少图片: ${file}`);
    continue;
  }
  copyFileSync(join(ASSETS, "memes", file), join(DEST, "memes", file));
  const fit = /适合([^。]+)/u.exec(desc);
  const entry = {
    id: `meme/${name}`,
    kind: "meme",
    file: `memes/${file}`,
    name,
    code: name,
    group: "表情包",
    tags: dedupeTags([
      ...splitTags(name),
      ...(fit ? fit[1].split(/[\/、，]/u).map((part) => part.trim()).filter(Boolean) : []),
    ], name),
    use: fit ? `适合${fit[1]}` : "",
    desc,
    en: "",
  };
  entry.emotion = emotionOf(entry);
  entry.tags = dedupeTags([...entry.tags, ...extraTagsOf(entry)], name);
  stickers.push(entry);
}

// ---- anim：109 段 10 秒动作的官方 GIF 预览 ----
const previewFiles = new Set(readdirSync(join(ASSETS, "preview")).filter((name) => name.endsWith(".gif")));
let missing = 0;
for (const name of groupOfAction.keys()) {
  const pinyin = PINYIN.get(name) ?? name;
  const file = `${pinyin}.gif`;
  if (!previewFiles.has(file)) {
    console.warn(`[skip] 缺少预览: ${name} → ${file}`);
    missing += 1;
    continue;
  }
  copyFileSync(join(ASSETS, "preview", file), join(DEST, "anim", file));
  const meta = groupOfAction.get(name);
  const entry = {
    id: `anim/${pinyin}`,
    kind: "anim",
    file: `anim/${file}`,
    name,
    code: pinyin,
    group: meta.group,
    tags: dedupeTags([meta.group, ...splitTags(name)], name),
    use: meta.use || `10秒动作（${meta.group}）`,
    desc: clean(promptMap.get(name) ?? "").slice(0, 150),
    en: pinyin,
  };
  entry.emotion = emotionOf(entry);
  entry.tags = dedupeTags([...entry.tags, ...extraTagsOf(entry)], name);
  stickers.push(entry);
}

let sourceRevision = "";
try {
  sourceRevision = execSync("git rev-parse --short HEAD", { cwd: SRC, encoding: "utf8" }).trim();
} catch {
  // 上游目录不是 git 检出时留空，不影响生成
}

const out = {
  $comment: "dsh-pet 素材索引：memes 来自 assets/memes，anim 来自 assets/preview（webm 母版的官方 GIF 预览）。由 tools/build-dsh-pet.mjs 生成。",
  source: "https://github.com/PC2005-cloud/dsh-pet",
  sourceRevision,
  license: "代码 MIT；素材非商用，形象 CC BY-NC-SA 4.0，详见同目录 NOTICE",
  stickers,
};
writeFileSync(join(DEST, "metadata.json"), `${JSON.stringify(out, null, 2)}\n`, "utf8");

const anims = stickers.filter((item) => item.kind === "anim").length;
console.log(`memes: ${stickers.length - anims}, anim: ${anims}, total: ${stickers.length}, 缺失: ${missing}`);
const groups = new Map();
for (const item of stickers) groups.set(item.group, (groups.get(item.group) ?? 0) + 1);
console.log("groups:", [...groups.entries()].map(([key, value]) => `${key}=${value}`).join(", "));
console.log(`带描述: ${stickers.filter((item) => item.desc).length}/${stickers.length}`);
const emotions = new Map();
for (const item of stickers) if (item.emotion) emotions.set(item.emotion, (emotions.get(item.emotion) ?? 0) + 1);
console.log("emotions:", [...emotions.entries()].map(([key, value]) => `${key}=${value}`).join(", "), `未标注=${stickers.length - [...emotions.values()].reduce((sum, value) => sum + value, 0)}`);
console.log(`上游版本: ${sourceRevision || "未知"}`);
