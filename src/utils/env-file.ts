/**
 * .env 文件的纯解析/序列化工具（供配置页服务使用，无副作用、可单测）。
 */

/** 解析 .env 文件为对象（丢弃注释与无 "=" 的行）。 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    result[key] = value;
  }
  return result;
}

/** 配置表单管理的 env 键；保存时不在此列表中的现有键会被原样保留 */
export const MANAGED_KEYS = new Set([
  "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_ADMIN", "FEISHU_RANDOM_EMOJIS",
  "FEISHU_PI_MODEL_PROVIDER", "FEISHU_PI_MODEL_NAME", "FEISHU_PI_MODEL_BASE_URL",
  "FEISHU_PI_MODEL_API_KEY", "FEISHU_PI_SYSTEM_PROMPT",
]);

/**
 * 将配置对象转换为 .env 格式。
 * existing 中不属于 MANAGED_KEYS 的键（如 FEISHU_GUARD_*、FEISHU_GROUP_<组名>、
 * FEISHU_APPROVAL_TIMEOUT_MS 等）按原顺序原样追加，避免保存表单时丢失手工配置。
 */
export function stringifyEnv(config: Record<string, string>, existing: Record<string, string> = {}): string {
  const lines: string[] = [];

  // 飞书配置
  lines.push("FEISHU_APP_ID=" + (config.FEISHU_APP_ID || ""));
  lines.push("FEISHU_APP_SECRET=" + (config.FEISHU_APP_SECRET || ""));
  lines.push("FEISHU_ADMIN=" + (config.FEISHU_ADMIN || ""));
  lines.push("");

  // 随机表情配置
  if (config.FEISHU_RANDOM_EMOJIS) {
    lines.push("# 随机表情配置（逗号分隔的 emoji_type）");
    lines.push("FEISHU_RANDOM_EMOJIS=" + config.FEISHU_RANDOM_EMOJIS);
    lines.push("");
  }

  // 模型配置
  lines.push("# 模型配置");
  const provider = config.FEISHU_PI_MODEL_PROVIDER || "anthropic";
  lines.push("FEISHU_PI_MODEL_PROVIDER=" + provider);
  lines.push("FEISHU_PI_MODEL_NAME=" + (config.FEISHU_PI_MODEL_NAME || "claude-sonnet-4-6"));
  lines.push("FEISHU_PI_MODEL_BASE_URL=" + (config.FEISHU_PI_MODEL_BASE_URL || ""));
  lines.push("");

  // API Key
  lines.push("# API Key");
  lines.push("FEISHU_PI_MODEL_API_KEY=" + (config.FEISHU_PI_MODEL_API_KEY || ""));
  lines.push("");

  // 系统提示词
  if (config.FEISHU_PI_SYSTEM_PROMPT) {
    lines.push("# 系统提示词（可选）");
    lines.push("FEISHU_PI_SYSTEM_PROMPT=" + config.FEISHU_PI_SYSTEM_PROMPT);
  }

  // 保留表单不管理的键（Guard 审核模型、权限分组、授权超时等手工配置）
  const emitted = new Set<string>();
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index > 0) emitted.add(line.slice(0, index));
  }
  for (const [key, value] of Object.entries(existing)) {
    if (!MANAGED_KEYS.has(key) && !emitted.has(key)) {
      lines.push("");
      lines.push(`${key}=${value}`);
    }
  }

  return lines.join("\n") + "\n";
}
