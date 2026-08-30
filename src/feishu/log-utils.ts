/** 格式化日志文本：去除换行，限制长度 */
export function formatLogText(text: string, maxLength = 100): string {
  const cleaned = text.replace(/[\r\n]+/g, " ").trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) + "..." : cleaned;
}
