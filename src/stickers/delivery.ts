import type { FeishuPiEvent } from "../runtime/types.ts";

/** 每轮独立收集真实工具结果，不从模型正文猜测图片身份。 */
/** 发图后的「解说腔」：描述图片内容、汇报发了几张、翻库存。真人不会这么说。 */
const STICKER_COMMENTARY = /^(?:我)?(?:先甩|再甩|甩了|甩两张|发你(?:一|两|几)张|给你(?:发|甩)(?:一|两|几)张)|^(?:我)?(?:从|去|在)?库存.{0,12}(?:挑|翻|找)|^这(?:一|两|几)张(?:表情包|图).{0,12}(?:分别是|一个是|另一个是)/u;
// Suppress only complaints about the medium, not short in-character retorts.
const STICKER_NAGGING = /不吭声只[丢发]图|只[丢发]图.{0,12}(没说话|没开口|问号)|看了.{0,8}张.{0,16}(没听|没说|开口)|(?:没听见|还没听到)你说.{0,6}话/u;

export function isStickerCommentary(text: string): boolean {
  return STICKER_COMMENTARY.test(text) || STICKER_NAGGING.test(text);
}

/** Remove clear delivery chatter per sentence, without swallowing a real answer.
 * Formatted/code replies are kept intact: this is only a chat cleanup fallback.
 */
export function stripStickerCommentary(text: string): string {
  if (/```|~~~|!\[|^\s*[#>|]/mu.test(text)) return text;
  return text.split(/(?<=[。！？!?])|(?=\n)|(?<=\n)/u)
    .filter(part => !isStickerCommentary(part.trim())).join("").trim();
}

export class StickerDelivery {
  private pending = new Map<string, { id: string; line: string; markdown: string }>();
  standaloneSent = false;

  observe(event: FeishuPiEvent): void {
    if (event.type !== "tool_finished" || event.toolName !== "sticker_send" || event.isError) return;
    const result = event.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
    if (!Array.isArray(result?.content)) return;
    for (const block of result.content) {
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      try {
        const value = JSON.parse(block.text);
        if (!value || typeof value.id !== "string") continue;
        if (value.sent === true && typeof value.messageId === "string" && value.messageId) this.standaloneSent = true;
        if (value.status !== "uploaded_pending_card" || typeof value.imageKey !== "string" || !value.imageKey || typeof value.line !== "string" || typeof value.markdown !== "string") continue;
        this.pending.set(value.imageKey, { id: value.id, line: value.line, markdown: value.markdown });
      } catch { /* 非结构化结果不作为发送凭证。 */ }
    }
  }

  async confirm(text: string, record: (id: string, line: string) => Promise<void>): Promise<void> {
    // 代码示例里的图片语法不算实际图片。仅匹配工具返回的完整片段。
    const visible = text.replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1/g, "").replace(/`+[^`]*`+/g, "");
    for (const [key, item] of this.pending) {
      if (!visible.includes(item.markdown) || visible.includes(`\\${item.markdown}`)) continue;
      await record(item.id, item.line);
      this.pending.delete(key);
    }
  }
}
