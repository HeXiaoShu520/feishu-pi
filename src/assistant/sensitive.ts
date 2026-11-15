/** 敏感内容识别：拒绝把密钥、验证码、令牌等原文带进 B 站自动互动等外部流程。 */
export function containsSensitiveText(text: string): boolean {
  if (/(密码|口令|验证码|密钥|私钥|令牌|凭证|cookie|password|api[_ -]?key|access[_ -]?token|bearer\s+\S+|sessdata|bili_jct)/i.test(text)) return true;
  return [process.env.FEISHU_PI_MODEL_API_KEY, process.env.FEISHU_APP_SECRET, process.env.FEISHU_GUARD_API_KEY]
    .some(value => !!value && value.length >= 4 && text.includes(value));
}
