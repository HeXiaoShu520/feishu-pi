/**
 * 飞书「收藏表情」消息（sticker）的解析。
 *
 * 这类消息的正文是 `<sticker key="..."/>`，模型看不懂裸 XML，也不会自动下载图片。
 * 收藏表情的 file_key 可以用于转发，但飞书公开资源接口不支持下载。
 * 不能将占位符当成模型已经看过的图片。
 */

const STICKER_TAG = /<sticker[^>]*\bkey=["']([^"']+)["'][^>]*\/?>/i;

/** 从归一化文本或原始 JSON 中取表情资源 key；取不到返回 undefined。 */
export function extractStickerKey(content: string, rawContent = ""): string | undefined {
  const fromTag = STICKER_TAG.exec(content)?.[1] ?? STICKER_TAG.exec(rawContent)?.[1];
  if (fromTag) return fromTag;
  try {
    const value = JSON.parse(rawContent) as { file_key?: unknown; image_key?: unknown; key?: unknown };
    for (const key of [value.file_key, value.image_key, value.key]) {
      if (typeof key === "string" && key) return key;
    }
  } catch { /* 不是 JSON 就按没有资源处理。 */ }
  return undefined;
}

/** 去掉表情消息里的 XML 标签，留下可读文本；空结果由调用方补 `[表情包]`。 */
export function stripStickerTag(text: string): string {
  return text.replace(/<sticker[^>]*\/?>/gi, "").trim();
}

export const VISIBLE_IMAGE_MESSAGE = "[图片消息：内容见附图]";
export const VISIBLE_STICKER_MESSAGE = "[对方发来的表情]";
export const UNAVAILABLE_STICKER_MESSAGE = "[飞书收藏表情：平台仅提供表情标识，本轮未取得图像，配字和画面未知]";
export const UNAVAILABLE_IMAGE_MESSAGE = "[图片资源未取得：本轮无法查看画面]";

/** Describes visibility, without guessing that every image is a meme battle. */
export function imageMessageText(text: string, kind: "image" | "sticker", visible: boolean): string {
  const body = stripStickerTag(text).replace(/\[(?:图片|附件)\][^\n]*/gu, "")
    .replace(/\[(?:表情包|sticker|image)\]/giu, "").trim();
  const status = visible ? kind === "sticker" ? VISIBLE_STICKER_MESSAGE : VISIBLE_IMAGE_MESSAGE
    : kind === "sticker" ? UNAVAILABLE_STICKER_MESSAGE : UNAVAILABLE_IMAGE_MESSAGE;
  return body ? `${body}\n${status}` : status;
}
