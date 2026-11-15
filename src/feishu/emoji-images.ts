/**
 * 飞书原生表情图片：中文名 → 官方 emoji_type → CDN 图片。
 *
 * 首次遇到时下载到本地缓存，作为图片一起送给模型；文字原样保留，不额外加意图注解。
 * 未收录的表情名保持原样，不影响消息处理。
 *
 * URL 来自飞书开放平台「表情文案说明」；部分 open-platform-opendoc 链接是协议相对的，
 * 这里统一补 https:。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../utils/logger.ts";

const CDN = "https://sf3-ttcdn-tos.pstatp.com/obj/lark-reaction-cn/";
const OPEN = "https://sf3-cn.feishucdn.com/obj/open-platform-opendoc/";

/** 官方 emoji_type → 图片 URL。 */
const EMOJI_URLS: Record<string, string> = {
  OK: `${CDN}emoji_ok_v2.png`,
  THUMBSUP: `${CDN}emoji_thumbsup_v2.png`,
  THANKS: `${CDN}emoji_thanks_v2.png`,
  MUSCLE: `${CDN}emoji_fighton_v2.png`,
  FINGERHEART: `${CDN}emoji_fingerheart_v2.png`,
  APPLAUSE: `${CDN}emoji_applaud_v2.png`,
  FISTBUMP: `${CDN}emoji_fistbump_v2.png`,
  JIAYI: `${CDN}emoji_plusone.png`,
  DONE: `${CDN}emoji_done.png`,
  SMILE: `${CDN}emoji_smile.png`,
  BLUSH: `${CDN}emoji_grin.png`,
  LAUGH: `${CDN}emoji_laugh.png`,
  SMIRK: `${CDN}emoji_smirk.png`,
  LOL: `${CDN}emoji_lol.png`,
  FACEPALM: `${CDN}emoji_facepalm.png`,
  LOVE: `${CDN}emoji_love.png`,
  WINK: `${CDN}emoji_wink.png`,
  PROUD: `${CDN}emoji_proud.png`,
  WITTY: `${CDN}emoji_witty.png`,
  SMART: `${CDN}emoji_smart.png`,
  SCOWL: `${CDN}emoji_scowl.png`,
  THINKING: `${CDN}emoji_thinking.png`,
  SOB: `${CDN}emoji_sob.png`,
  CRY: `${CDN}emoji_cry.png`,
  ERROR: `${CDN}emoji_errr.png`,
  NOSEPICK: `${CDN}emoji_nosepick.png`,
  HAUGHTY: `${CDN}emoji_irritated_v2.png`,
  SLAP: `${CDN}emoji_slap.png`,
  SPITBLOOD: `${CDN}emoji_spitblood.png`,
  TOASTED: `${CDN}emoji_toasted.png`,
  GLANCE: `${CDN}emoji_glance.png`,
  DULL: `${CDN}emoji_dull.png`,
  INNOCENTSMILE: `${CDN}emoji_innocentsmile.png`,
  JOYFUL: `${CDN}emoji_joyful.png`,
  WOW: `${CDN}emoji_wow.png`,
  TRICK: `${CDN}emoji_trick.png`,
  YEAH: `${CDN}emoji_yeah.png`,
  ENOUGH: `${CDN}emoji_enough.png`,
  TEARS: `${CDN}emoji_tears.png`,
  EMBARRASSED: `${CDN}emoji_embarrassed.png`,
  KISS: `${CDN}emoji_kiss.png`,
  SMOOCH: `${CDN}emoji_smooch.png`,
  DROOL: `${CDN}emoji_drool.png`,
  OBSESSED: `${CDN}emoji_obsessed.png`,
  MONEY: `${CDN}emoji_dollar.png`,
  TEASE: `${CDN}emoji_tease.png`,
  SHOWOFF: `${CDN}emoji_showoff.png`,
  COMFORT: `${CDN}emoji_comfort.png`,
  CLAP: `${CDN}emoji_clap.png`,
  PRAISE: `${CDN}emoji_praise.png`,
  STRIVE: `${CDN}emoji_strive.png`,
  XBLUSH: `${CDN}emoji_blush.png`,
  SILENT: `${CDN}emoji_silent.png`,
  WAVE: `${CDN}emoji_wave.png`,
  WHAT: `${CDN}emoji_what.png`,
  FROWN: `${CDN}emoji_frown.png`,
  SHY: `${CDN}emoji_shy.png`,
  DIZZY: `${CDN}emoji_dizzy.png`,
  LOOKDOWN: `${CDN}emoji_lookdown.png`,
  CHUCKLE: `${CDN}emoji_chuckle.png`,
  WAIL: `${CDN}emoji_wail.png`,
  CRAZY: `${CDN}emoji_crazy.png`,
  WHIMPER: `${CDN}emoji_whimper.png`,
  HUG: `${CDN}emoji_hug.png`,
  BLUBBER: `${CDN}emoji_blubber.png`,
  WRONGED: `${CDN}emoji_wronged.png`,
  HUSKY: `${CDN}emoji_husky.png`,
  SHHH: `${CDN}emoji_shhh.png`,
  SMUG: `${CDN}emoji_smug.png`,
  ANGRY: `${CDN}emoji_angry.png`,
  HAMMER: `${OPEN}9f58ae35392bf5ef632ee1fc68aaaaa6_mLDLyug1S7.png`,
  SHOCKED: `${CDN}emoji_shocked.png`,
  TERROR: `${CDN}emoji_terror.png`,
  PETRIFIED: `${CDN}emoji_petrified.png`,
  SKULL: `${CDN}emoji_skull.png`,
  SWEAT: `${CDN}emoji_sweat.png`,
  SPEECHLESS: `${CDN}emoji_speechless.png`,
  SLEEP: `${CDN}emoji_sleep.png`,
  DROWSY: `${CDN}emoji_drowsy.png`,
  YAWN: `${CDN}emoji_yawn.png`,
  SICK: `${CDN}emoji_sick.png`,
  PUKE: `${CDN}emoji_puke.png`,
  BETRAYED: `${CDN}emoji_betrayed.png`,
  HEADSET: `${CDN}emoji_headset_v3.png`,
  EatingFood: `${CDN}emoji_eatingfood_v2.png`,
  MeMeMe: `${CDN}emoji_mememe.png`,
  Sigh: `${CDN}emoji_sigh.png`,
  Typing: `${CDN}emoji_typing.png`,
  Lemon: `${CDN}emoji_lemon_v2.png`,
  Get: `${CDN}emoji_get_v3.png`,
  LGTM: `${CDN}emoji_lgtm_v3.png`,
  OnIt: `${OPEN}e01b24ed3d58ad17a3e9d6b94dc73e4b_nXfu7jkz2H.png`,
  OneSecond: `${CDN}emoji_onesecond.png`,
  VRHeadset: `${CDN}emoji_vrheadset_v1.png`,
  YouAreTheBest: `${CDN}emoji_youarethebest.png`,
  SALUTE: `${CDN}emoji_salute_v2.png`,
  SHAKE: `${CDN}emoji_shake_v2.png`,
  HIGHFIVE: `${CDN}emoji_highfive_v2.png`,
  UPPERLEFT: `${CDN}emoji_click_v2.png`,
  ThumbsDown: `${CDN}emoji_thumbsdown_v2.png`,
  SLIGHT: `${CDN}emoji_slight.png`,
  TONGUE: `${CDN}emoji_tongue.png`,
  EYESCLOSED: `${CDN}emoji_eyesclosed.png`,
  RoarForYou: `${CDN}emoji_roarforyou.png`,
  CALF: `${CDN}emoji_calf.png`,
  BEAR: `${CDN}emoji_bear.png`,
  BULL: `${CDN}emoji_bull.png`,
  RAINBOWPUKE: `${CDN}emoji_rainbowpuke_v2.png`,
  ROSE: `${CDN}emoji_rose.png`,
  HEART: `${CDN}emoji_heart.png`,
  PARTY: `${CDN}emoji_party.png`,
  LIPS: `${OPEN}2e220353409b385bc596177d02dd215e_vzI98bHVC4.png`,
  BEER: `${CDN}emoji_beer.png`,
  CAKE: `${CDN}emoji_cake_v2.png`,
  GIFT: `${CDN}emoji_gift_v3.png`,
  CUCUMBER: `${CDN}emoji_cucumber_v3.png`,
  Drumstick: `${CDN}emoji_drumstick.png`,
  Pepper: `${CDN}emoji_pepper.png`,
  CANDIEDHAWS: `${CDN}emoji_candiedhaws.png`,
  BubbleTea: `${CDN}emoji_bubbletea.png`,
  Coffee: `${CDN}emoji_coffee_v2.png`,
  Yes: `${CDN}emoji_yes_v2.png`,
  No: `${CDN}emoji_no_v3.png`,
  OKR: `${CDN}emoji_okr.png`,
  CheckMark: `${CDN}emoji_checkmark.png`,
  CrossMark: `${CDN}emoji_crossmark.png`,
  MinusOne: `${CDN}emoji_minusone_v4.png`,
  Hundred: `${CDN}emoji_hundred.png`,
  AWESOMEN: `${CDN}emoji_socool_v2.png`,
  Pin: `${CDN}emoji_pin.png`,
  Alarm: `${CDN}emoji_alarm.png`,
  Loudspeaker: `${CDN}emoji_loudspeaker.png`,
  Trophy: `${CDN}emoji_trophy.png`,
  Fire: `${CDN}emoji_fire.png`,
  BOMB: `${CDN}emoji_bomb.png`,
  Music: `${CDN}emoji_music_v2.png`,
  XmasTree: `${CDN}emoji_xmastree.png`,
  Snowman: `${CDN}emoji_snowman.png`,
  XmasHat: `${CDN}emoji_xmashat.png`,
  FIREWORKS: `${CDN}emoji_fireworks_v2.png`,
  "2022": `${CDN}emoji_twentytwentytwo.png`,
  REDPACKET: `${CDN}emoji_redpacket_v2.png`,
  FORTUNE: `${OPEN}147622203e2662bb52dd3579678e6d6a_tSa2ZaOgaS.png`,
  LUCK: `${CDN}emoji_luck.png`,
  FIRECRACKER: `${CDN}emoji_firecracker_v3.png`,
  StickyRiceBalls: `${CDN}emoji_stickyriceballs.png`,
  HEARTBROKEN: `${CDN}emoji_heartbroken.png`,
  POOP: `${CDN}emoji_poop.png`,
  StatusFlashOfInspiration: `${CDN}emoji_statusflashofInspiration.png`,
  "18X": `${CDN}emoji_eighteen.png`,
  CLEAVER: `${OPEN}d920620f7b7a30fd2bf6cd565eae1d0a_I67ZCFoRsS.png`,
  Soccer: `${CDN}emoji_soccer_v3.png`,
  Basketball: `${CDN}emoji_basketball_v3.png`,
  GeneralDoNotDisturb: `${OPEN}742f3142e94afcd1cc4f4764d7c3174d_Xy8YMH6pha.png`,
  Status_PrivateMessage: `${CDN}emoji_status_privatemessage.png`,
  GeneralInMeetingBusy: `${CDN}emoji_generalInmeetingbusy_v2.png`,
  StatusReading: `${CDN}emoji_statusreading.png`,
  StatusInFlight: `${CDN}emoji_statusinflight.png`,
  GeneralBusinessTrip: `${CDN}emoji_generalbusinesstrip_v2.png`,
  GeneralWorkFromHome: `${CDN}emoji_generalworkfromhome.png`,
  StatusEnjoyLife: `${CDN}emoji_statusenjoylife.png`,
  GeneralTravellingCar: `${CDN}emoji_generaltravellingcar.png`,
  StatusBus: `${CDN}emoji_statusbus.png`,
  GeneralSun: `${CDN}emoji_generalsun.png`,
  GeneralMoonRest: `${CDN}emoji_generalmoonrest_v2.png`,
  MoonRabbit: `${OPEN}dbfb263893cdc014f73685851b1352be_mBFyIx7ApY.png`,
  Mooncake: `${OPEN}87bc24c03541a1ced9dddfb24fdb1865_D716318HXN.png`,
  JubilantRabbit: `${OPEN}45497d37d491c959a29a552c89b4d887_9YCTU0usnA.png`,
  TV: `${OPEN}ab217b43ca7d0495cf46519271ffe7d6_S7JYKcnKVZ.png`,
  Movie: `${OPEN}b332964ff17528489d91d0760a2a4ed8_kxPGKVx0qY.png`,
  Pumpkin: `${OPEN}fa192c5f1bc49b4f51de7580a605af7a_2yFMrKG9ou.png`,
  BeamingFace: `${OPEN}92daa29e246314a382ae764dfc87f641_BqicyGCojS.png`,
  Delighted: `${OPEN}a9fe96121ba5e39b68a9fd3993f80b01_M8cfYKkM9U.png`,
  ColdSweat: `${OPEN}06985ef8af8d8b8b4219e690bd4e989e_mTUTPYP5dY.png`,
  FullMoonFace: `${OPEN}81e0b36d0fb3a9fcd9dec713e9750c1b_ciYC93YonW.png`,
  Partying: `${OPEN}9cfb7be26a970caae6d774498474988f_sQ3pgWOu31.png`,
  GoGoGo: `${OPEN}0a6df90764cd0d3f01d85bca6c814fb7_tvwAnSsTJS.png`,
  ThanksFace: `${OPEN}a912450d9e0f85ad9455b3197634ee14_k46oc6Ok7K.png`,
  SaluteFace: `${OPEN}c16a76d4e345b0d098bbf39eb1a1eb59_QA6zdwvDqi.png`,
  Shrug: `${OPEN}756651e468c367877deb996502e14408_QkZKDz5o5T.png`,
  ClownFace: `${OPEN}860a4e71696cdcde0e218565ef5bf3b1_lOjQS7FSKS.png`,
  HappyDragon: `${OPEN}e8f7bab6f3609283a80c8f15d83f5580_gL6Cwjsqnu.png`,
};

/** 中文名/常见别名 → 官方 emoji_type。一个 type 可以有多个别名。 */
const NAME_TO_TYPE: Record<string, string> = {
  // 表情与情绪
  "微笑": "SMILE", "呵呵": "SMILE", "呲牙": "BLUSH", "咧嘴笑": "BLUSH",
  "大笑": "LAUGH", "笑": "LAUGH", "偷笑": "CHUCKLE", "捂嘴笑": "CHUCKLE",
  "笑哭": "LOL", "笑死": "LOL", "得意": "SMIRK", "坏笑": "TRICK",
  "机智": "WITTY", "聪明": "SMART", "骄傲": "PROUD", "自豪": "PROUD",
  "傲慢": "HAUGHTY", "哼": "HAUGHTY", "不屑": "SCOWL", "皱眉": "SCOWL",
  "思考": "THINKING", "想": "THINKING", "疑问": "WHAT", "什么": "WHAT",
  "震惊": "SHOCKED", "惊讶": "SHOCKED", "害怕": "TERROR", "恐惧": "TERROR",
  "石化": "PETRIFIED", "骷髅": "SKULL", "完蛋": "SKULL", "裂开": "SKULL",
  "晕": "DIZZY", "抓狂": "CRAZY", "发疯": "CRAZY", "生气": "ANGRY",
  "愤怒": "ANGRY", "打脸": "SLAP", "吐血": "SPITBLOOD", "焦了": "TOASTED",
  "看": "GLANCE", "白眼": "GLANCE", "瞥": "GLANCE", "呆": "DULL",
  "呆滞": "DULL", "黑线": "DULL", "无辜": "INNOCENTSMILE", "无辜笑": "INNOCENTSMILE",
  "开心": "JOYFUL", "高兴": "JOYFUL", "耶": "YEAH", "够了": "ENOUGH",
  "眼泪": "TEARS", "哭": "CRY", "大哭": "CRY", "嚎啕大哭": "WAIL",
  "抽泣": "WHIMPER", "哭唧唧": "SOB", "尴尬": "EMBARRASSED", "尬笑": "SWEAT",
  "汗": "SWEAT", "汗颜": "SWEAT", "无语": "SPEECHLESS", "闭嘴": "SILENT",
  "嘘": "SHHH", "害羞": "SHY", "脸红": "XBLUSH", "亲亲": "KISS",
  "飞吻": "SMOOCH", "流口水": "DROOL", "痴迷": "OBSESSED", "钱": "MONEY",
  "撩": "TEASE", "炫耀": "SHOWOFF", "安慰": "COMFORT", "委屈": "WRONGED",
  "抱抱": "HUG", "拥抱": "HUG", "叹气": "Sigh", "困": "DROWSY",
  "睡": "SLEEP", "哈欠": "YAWN", "生病": "SICK", "吐": "PUKE",
  "彩虹吐": "RAINBOWPUKE", "背叛": "BETRAYED", "撇嘴": "FROWN", "苦脸": "FROWN",
  "低头": "LOOKDOWN", "闭眼": "EYESCLOSED", "吐舌": "TONGUE", "眨眼": "WINK",
  "害羞笑": "SLIGHT", "满月脸": "FullMoonFace", "笑脸": "BeamingFace",
  "开心脸": "Delighted", "冷笑": "ColdSweat", "小丑": "ClownFace",
  "摊手": "Shrug", "耸肩": "Shrug", "灵光一闪": "StatusFlashOfInspiration",
  "18禁": "18X", "菜刀": "CLEAVER", "锤子": "HAMMER", "锤": "HAMMER",
  // 动作与互动
  "赞": "THUMBSUP", "点赞": "THUMBSUP", "踩": "ThumbsDown", "差评": "ThumbsDown",
  "谢谢": "THANKS", "感谢": "THANKS", "加油": "MUSCLE", "肌肉": "MUSCLE",
  "比心": "FINGERHEART", "鼓掌": "APPLAUSE", "拍手": "CLAP", "表扬": "PRAISE",
  "碰拳": "FISTBUMP", "加一": "JIAYI", "完成": "DONE", "好的": "OK",
  "OK": "OK", "收到": "OK", "努力": "STRIVE", "冲": "GoGoGo",
  "敬礼": "SALUTE", "握手": "SHAKE", "击掌": "HIGHFIVE", "左上": "UPPERLEFT",
  "懂了": "Get", "马上": "OnIt", "等一下": "OneSecond", "你最棒": "YouAreTheBest",
  "看着不错": "LGTM", "为你吼": "RoarForYou", "牛": "CALF", "熊": "BEAR",
  "公牛": "BULL", "是": "Yes", "否": "No", "对勾": "CheckMark",
  "叉": "CrossMark", "减一": "MinusOne", "一百": "Hundred", "太酷了": "AWESOMEN",
  "钉住": "Pin", "闹钟": "Alarm", "喇叭": "Loudspeaker", "奖杯": "Trophy",
  "火": "Fire", "炸弹": "BOMB", "音乐": "Music", "耳机": "HEADSET",
  "VR": "VRHeadset", "打字": "Typing", "我我我": "MeMeMe", "吃饭": "EatingFood",
  "碰杯": "BEER", "干杯": "BEER", "咖啡": "Coffee", "奶茶": "BubbleTea",
  "柠檬": "Lemon", "鸡腿": "Drumstick", "辣椒": "Pepper", "糖葫芦": "CANDIEDHAWS",
  "黄瓜": "CUCUMBER", "蛋糕": "CAKE", "月饼": "Mooncake", "汤圆": "StickyRiceBalls",
  "南瓜": "Pumpkin", "西瓜": "CUCUMBER", "玫瑰": "ROSE", "爱心": "HEART",
  "心碎": "HEARTBROKEN", "嘴唇": "LIPS", "礼物": "GIFT", "红包": "REDPACKET",
  "福": "FORTUNE", "好运": "LUCK", "庆祝": "PARTY", "派对": "Partying",
  "烟花": "FIREWORKS", "鞭炮": "FIRECRACKER", "圣诞树": "XmasTree",
  "雪人": "Snowman", "圣诞帽": "XmasHat", "月兔": "MoonRabbit",
  "玉兔": "JubilantRabbit", "龙": "HappyDragon", "足球": "Soccer",
  "篮球": "Basketball", "电视": "TV", "电影": "Movie", "便便": "POOP",
  "旺柴": "HUSKY", "狗头": "HUSKY", "哈士奇": "HUSKY",
  // 状态
  "太阳": "GeneralSun", "早安": "GeneralSun", "月亮": "GeneralMoonRest",
  "晚安": "GeneralMoonRest", "请勿打扰": "GeneralDoNotDisturb",
  "私信": "Status_PrivateMessage", "会议中": "GeneralInMeetingBusy",
  "阅读中": "StatusReading", "飞行中": "StatusInFlight", "出差": "GeneralBusinessTrip",
  "在家办公": "GeneralWorkFromHome", "享受生活": "StatusEnjoyLife",
  "出差车": "GeneralTravellingCar", "公交": "StatusBus",
};

const memoryCache = new Map<string, Uint8Array>();
const failed = new Set<string>();

export interface EmojiImage {
  data: Uint8Array;
  mimeType: string;
  name: string;
}

/** 中文表情名 → { type, url }；未收录返回 undefined。 */
export function resolveEmojiImage(name: string): { type: string; url: string } | undefined {
  const type = NAME_TO_TYPE[name.trim()];
  const url = type ? EMOJI_URLS[type] : undefined;
  return type && url ? { type, url } : undefined;
}

/** 从消息正文中按出现顺序取出已知表情名，去重。 */
export function extractEmojiNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/\[([^\[\]\n]{1,10})\]/g)) {
    const name = match[1].trim();
    if (resolveEmojiImage(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

function cacheFile(cacheDir: string, type: string): string {
  return join(cacheDir, `${type.replace(/[^A-Za-z0-9_]/g, "_")}.png`);
}

async function loadOne(name: string, cacheDir: string | undefined, maxBytes: number, fetchImpl: typeof fetch): Promise<Uint8Array | undefined> {
  const resolved = resolveEmojiImage(name);
  if (!resolved) return undefined;
  const cached = memoryCache.get(resolved.type);
  if (cached) return cached;
  if (failed.has(resolved.type)) return undefined;

  if (cacheDir) {
    try {
      const data = new Uint8Array(await readFile(cacheFile(cacheDir, resolved.type)));
      memoryCache.set(resolved.type, data);
      return data;
    } catch { /* 首次没有缓存，继续下载。 */ }
  }

  try {
    const response = await fetchImpl(resolved.url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > maxBytes) throw new Error("图片大小异常");
    memoryCache.set(resolved.type, data);
    if (cacheDir) {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cacheFile(cacheDir, resolved.type), data).catch(() => undefined);
    }
    return data;
  } catch (error) {
    failed.add(resolved.type);
    logger.warn(`[FeishuEmoji] 表情图片加载失败 ${name}:`, error instanceof Error ? error.message : error);
    return undefined;
  }
}

/** 批量加载表情图片；按上限截断，失败项跳过。 */
export async function loadFeishuEmojiImages(
  names: string[],
  options: { cacheDir?: string; maxBytes?: number; limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<EmojiImage[]> {
  const limit = options.limit ?? 3;
  const maxBytes = options.maxBytes ?? 200 * 1024;
  const fetchImpl = options.fetchImpl ?? fetch;
  const images: EmojiImage[] = [];
  for (const name of names.slice(0, limit)) {
    const data = await loadOne(name, options.cacheDir, maxBytes, fetchImpl);
    if (data) images.push({ data, mimeType: "image/png", name });
  }
  return images;
}
