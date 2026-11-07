/**
 * 消息内容提取工具：从 Pi 消息 content 结构中提取纯文本。
 * 供 runtime 与 memory 模块共用，避免重复实现。
 */

/** 从消息 content（字符串或内容块数组）中提取纯文本；图片块返回占位符。 */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const item = block as { type?: unknown; text?: unknown };
    if (item.type === "text" && typeof item.text === "string") return item.text;
    if (item.type === "image") return "[图片]";
    return "";
  }).filter(Boolean).join("\n");
}
