import type { FeishuPiHistoryMessage } from "../runtime/types.ts";

export function containsSensitiveText(text: string): boolean {
  if (/(密码|口令|验证码|密钥|私钥|令牌|凭证|cookie|password|api[_ -]?key|access[_ -]?token|bearer\s+\S+|sessdata|bili_jct)/i.test(text)) return true;
  return [process.env.FEISHU_PI_MODEL_API_KEY, process.env.FEISHU_APP_SECRET, process.env.FEISHU_GUARD_API_KEY]
    .some(value => !!value && value.length >= 4 && text.includes(value));
}

/** Drop an entire turn if either side contains a credential, including echoed values. */
export function safeMemoryHistory(history: FeishuPiHistoryMessage[]): FeishuPiHistoryMessage[] {
  const input = history.slice(-6);
  const safe: FeishuPiHistoryMessage[] = [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (item.role !== "user") continue;
    const reply = item.role === "user" && input[i + 1]?.role === "assistant" ? input[++i] : undefined;
    if (containsSensitiveText(item.content) || (reply && containsSensitiveText(reply.content))) continue;
    safe.push({ role: item.role, content: item.content.slice(0, 1000) });
    if (reply) safe.push({ role: reply.role, content: reply.content.slice(0, 1000) });
  }
  return safe;
}
