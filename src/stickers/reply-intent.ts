/** Response direction chosen by the conversational model, never inferred from
 * unreadable incoming media. These are alternative retrieval phrases, not lines
 * to send or assertions about the user's emotion.
 */
export const STICKER_REPLIES = ["counter", "dodge", "surrender", "tease", "welcome", "agree", "comfort"] as const;
export type StickerReply = typeof STICKER_REPLIES[number];
export const REPLY_TERMS: Record<StickerReply, readonly string[]> = {
  counter: ["放马过来", "反击", "反弹", "不服", "你也不过如此", "谁怕谁", "接招"],
  dodge: ["躲开", "闪避", "护盾", "防御", "挡住", "打不着", "溜了"],
  surrender: ["认输", "投降", "饶命", "打不过", "我错了", "别打了"],
  tease: ["就这", "不屑", "得瑟", "小样", "嘲笑", "你继续", "挑衅"],
  welcome: ["欢迎", "你来了", "登场", "好久不见", "打招呼"],
  agree: ["赞同", "确实", "有道理", "说得对", "点头"],
  comfort: ["抱抱", "安慰", "辛苦了", "陪着", "加油", "摸摸头"],
};
