/** Small, bounded results keep adapters independent of transport and card rendering. */
export function textResult(value: unknown, maxChars = 20_000) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text: text.length > maxChars ? `${text.slice(0, maxChars)}\n[输出已截断]` : text }], details: {} };
}
