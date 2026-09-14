/**
 * 对话历史脱敏：进入会话记录（session jsonl）前把凭证类内容遮蔽。
 *
 * 背景：/login <provider> 体系下，用户可能在聊天中提交凭证（如 bitbucket 的
 * app password、各平台的 user_access_token）。会话 jsonl 是明文 JSON 落盘，
 * 凭证一旦进入就长期留存——因此在文本进入会话前统一脱敏。
 *
 * 原则：宁可漏报不可误伤正文——所有规则只命中"高熵长串/明确凭证形态"，
 * 遮蔽格式为"保留前 4 后 2，中间 ***"（短串全遮）。
 */

const MASKED = (secret: string): string => {
  if (secret.length <= 8) return "***";
  return `${secret.slice(0, 4)}***${secret.slice(-2)}`;
};

/** 规则集：每条按顺序应用，命中即遮蔽其捕获的凭证段 */
const RULES: Array<{ pattern: RegExp; secretGroup: number }> = [
  // JWT 三段式（飞书 user_access_token 的常见形态：eyJ……）
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, secretGroup: 0 },
  // Bearer 头
  { pattern: /\b(Bearer\s+)([A-Za-z0-9._~-]{16,})/gi, secretGroup: 2 },
  // 键值形态：token/password/secret/key/app_password = "值"（覆盖粘贴提交凭证的场景）
  { pattern: /\b(token|password|passwd|secret|api[_-]?key|app[_-]?password|access[_-]?token|refresh[_-]?token)\b(\s*[=:]\s*)(["']?)([^\s"'&,;）)]{12,})/gi, secretGroup: 4 },
  // 高熵长串（40+ 位 base64url / hex；阈值取高避免误伤 open_id 等普通标识）
  { pattern: /\b[A-Za-z0-9_-]{40,}\b/g, secretGroup: 0 },
  // 32 位 hex（bitbucket app password 等）
  { pattern: /\b[a-f0-9]{32}\b/gi, secretGroup: 0 },
];

/**
 * 遮蔽文本中的凭证类内容。纯函数：返回脱敏后的副本，不修改输入。
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, secretGroup } of RULES) {
    result = result.replace(pattern, (match, ...groups) => {
      // secretGroup 为 0 时整个 match 即凭证；否则取对应捕获组（其余部分如 "Bearer "、"token=" 保留）
      const secret = secretGroup === 0 ? match : (groups[secretGroup - 1] as string | undefined);
      if (!secret) return match;
      const masked = MASKED(secret);
      return secretGroup === 0 ? masked : match.replace(secret, masked);
    });
  }
  return result;
}

/** 是否包含疑似凭证（供调用方决定是否需要提示，可选辅助） */
export function containsSecretLike(text: string): boolean {
  return redactSecrets(text) !== text;
}
