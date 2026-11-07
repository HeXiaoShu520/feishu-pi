import type { FeishuPiEvent } from "../runtime/types.ts";

/** 每轮独立收集真实工具结果，不从模型正文猜测图片身份。 */
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
