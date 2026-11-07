/**
 * 表情工具的说明文案：三处注册点共用，避免描述漂移。
 * 按 AGENTS.md 的指令分层准则，使用策略写在这里（随注册进入请求），
 * 不写进静态的 .agent/SYSTEM.md。
 */
import type { StickerGuide } from "./rules.ts";

/** nekowhale 的固定情绪词表，用于 emotion 过滤与工具描述 */
export const STICKER_EMOTIONS = [
  "开心", "大笑", "喜欢", "害羞", "得意", "兴奋", "惊讶", "疑惑", "思考", "无语",
  "难过", "哭", "生气", "害怕", "疲惫", "赞同", "拒绝", "打招呼", "感谢", "道歉",
  "卖萌", "搞怪", "嘲讽", "安慰", "其他",
] as const;

/** 搜索空结果时给模型的下一步指引，两个注册点共用 */
export const STICKER_EMPTY_HINT =
  "没有命中。去掉 pack/emotion 限制再试，或换 开心/累/困/吃/玩/睡 这类常见中文场景词（图库是中文标注，英文搜不到）";

const GUIDE: Record<StickerGuide, string> = {
  rare: "频率：平时少发，只在用户明确要表情、斗图或气氛明显轻松时用。",
  normal: "频率：气氛轻松时可以偶尔用；用户在认真解决问题或话题沉重时少发。",
  often: "频率：可以较主动地用表情补充语气，但一条回复通常不超过一张，用户明确要多张时例外。",
};

export function stickerSearchDescription(guide: StickerGuide): string {
  return [
    "检索你自己的反应表情包（你本人就是大肥鱼，不是替别人找图）。",
    "query 用情绪或场景词，例如 摸鱼、被夸、下班、阴阳怪气；",
    `emotion 可精确限定情绪：${STICKER_EMOTIONS.join("/")}。情绪标注主要在 nekowhale，dsh-pet 只有部分动作有，其余来源没有；emotion 与 pack 同用时确认该包真的有这个情绪。`,
    "每行格式为「名字｜情绪｜标签｜方向」，方向形如「大肥鱼→GPT娘」，说明双人表情谁对谁做。",
    "desc 是画面摘要；拿不准动作内容时看它再选，别只看名字猜。",
    "你最近发过的会自动排后，不用刻意回避重复；想换着发就按顺序挑。",
    "名字里的「猫猫」「喵喵」是大肥鱼的猫系动作，不是另一个角色。",
    "pack 可选来源：nekowhale/whale-girl/clawd/bluefish/emotelab 是聊天表情；dsh-pet 是 10 秒桌宠动作（吃西瓜、下五子棋、睡觉等），拿来做动作演示时优先它。",
    "需要按实际聊天或任务状态选大肥鱼动作时，可传 scene：thinking 思考、working 工作、waiting 等待、success 成功、failure 失败、resting 休息、greeting 打招呼；选之前根据真实事件判断，不能假装任务已成功，也不必每个状态都发图。scene 专找 dsh-pet 动作，通常不要同时限制 emotion 或其他 pack。",
    "本工具只检索不发送；挑中后把 id 交给 sticker_send。",
    GUIDE[guide],
  ].join("");
}

export function stickerSendDescription(guide: StickerGuide): string {
  return [
    "把一张表情发送到当前飞书聊天。id 可以是 sticker_search 返回的完整 id、表情名，或情绪词（如 开心，随机取该情绪的一张）。",
    "默认嵌入本回复卡片：调用结果的 markdown 字段是现成片段（如 ![大肥鱼 摸鱼](img_v2_xxx)），在最终答复里原样写出它，图就渲染在卡内；片段不在答复正文里表情就不会出现，别漏。",
    "要作为独立图片消息发送（不占卡片正文）时传 standalone: true；用户只要图不要文字（如「发个表情」）时用这条路径，答复留空即可，图本身就是回复。",
    "默认一条回复一张；用户明确要多张（如「多来两张」）时可以一次贴 2～3 张，贴紧话题即可，不要无限刷屏。",
    "dsh-pet 的动作是 10 秒循环动画：适合动作演示、烘托气氛或用户点名要看；日常快速回应优先其它包的短表情。",
    "把片段写进答复后正常继续说话，不要预告、不要问「要我发吗」，也不要说「用大肥鱼给你发」这类第三人称措辞。",
    GUIDE[guide],
    "上传或发送失败时如实告知用户。",
    "status=uploaded_pending_card 仅表示上传完成，不代表已发送；必须输出 markdown。meaning 来自图库标注，并非你实际看过图片，标注为空时不要编造画面内容。",
  ].join("");
}
