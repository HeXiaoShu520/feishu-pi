/**
 * 回复文本 emoji 清洗：FEISHU_PI_REPLY_EMOJI 关闭（默认）时在发送前兜底剥离。
 * 提示层已要求模型不用 emoji，这里是最后一道保险——模型偶发不听话时正文也不会混进表情。
 * 代码块（``` 围栏）内不动：那是代码/命令，删字符会改变语义。
 */
const EMOJI = /[\p{Extended_Pictographic}\uFE0F\u200D]+[ \t]?/gu;

export function stripEmoji(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(EMOJI, "")
            .replace(/[ \t]{2,}/g, " ")
            .replace(/[ \t]+$/gm, "")
            .replace(/\n{3,}/g, "\n\n"))
    .join("");
}
