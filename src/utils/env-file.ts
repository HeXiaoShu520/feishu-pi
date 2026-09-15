/**
 * .env 文件的纯解析/序列化工具（供配置页服务使用，无副作用、可单测）。
 */

/** 值必须是单行的：换行符折叠为空格（多行值会破坏 .env 逐行解析，
 *  且恶意换行可向 .env 注入任意键值对），其余控制字符剔除。 */
function sanitizeValue(value: string): string {
  return value.replace(/\r\n?/g, " ").replace(/\n/g, " ").replace(/[\0\b\f\v]/g, "");
}

/** 键名只允许字母数字下划线（防注入任意行）；非法键返回 undefined。 */
function sanitizeKey(key: string): string | undefined {
  const trimmed = key.trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? trimmed : undefined;
}

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
  "FEISHU_PI_MODEL_API_KEY", "FEISHU_PI_SYSTEM_PROMPT", "FEISHU_SHOW_MODEL_STATS",
]);

/**
 * 将配置对象转换为 .env 格式。
 * existing 中不属于 MANAGED_KEYS 的键（如 FEISHU_GUARD_*、FEISHU_GROUP_<组名>、
 * FEISHU_APPROVAL_TIMEOUT_MS 等）按原顺序原样追加，避免保存表单时丢失手工配置。
 * 所有值经 sanitizeValue 转义、保留键经 sanitizeKey 校验。
 */
export function stringifyEnv(config: Record<string, string>, existing: Record<string, string> = {}): string {
  const lines: string[] = [];
  const emit = (key: string, value: string): void => { lines.push(`${key}=${sanitizeValue(value)}`); };

  // 飞书配置
  emit("FEISHU_APP_ID", config.FEISHU_APP_ID || "");
  emit("FEISHU_APP_SECRET", config.FEISHU_APP_SECRET || "");
  emit("FEISHU_ADMIN", config.FEISHU_ADMIN || "");
  lines.push("");

  // 随机表情配置
  if (config.FEISHU_RANDOM_EMOJIS) {
    lines.push("# 随机表情配置（逗号分隔的 emoji_type）");
    emit("FEISHU_RANDOM_EMOJIS", config.FEISHU_RANDOM_EMOJIS);
    lines.push("");
  }

  // 模型配置
  lines.push("# 模型配置");
  const provider = config.FEISHU_PI_MODEL_PROVIDER || "anthropic";
  emit("FEISHU_PI_MODEL_PROVIDER", provider);
  emit("FEISHU_PI_MODEL_NAME", config.FEISHU_PI_MODEL_NAME || "claude-sonnet-4-6");
  emit("FEISHU_PI_MODEL_BASE_URL", config.FEISHU_PI_MODEL_BASE_URL || "");
  if (config.FEISHU_SHOW_MODEL_STATS) {
    // 回复末尾模型统计小字开关（1 开 / 0 关）
    emit("FEISHU_SHOW_MODEL_STATS", config.FEISHU_SHOW_MODEL_STATS);
  }
  lines.push("");

  // API Key
  lines.push("# API Key");
  emit("FEISHU_PI_MODEL_API_KEY", config.FEISHU_PI_MODEL_API_KEY || "");
  lines.push("");

  // 系统提示词
  if (config.FEISHU_PI_SYSTEM_PROMPT) {
    lines.push("# 系统提示词（可选）");
    emit("FEISHU_PI_SYSTEM_PROMPT", config.FEISHU_PI_SYSTEM_PROMPT);
  }

  // 保留表单不管理的键（Guard 审核模型、权限分组、授权超时等手工配置）
  const emitted = new Set<string>();
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index > 0) emitted.add(line.slice(0, index));
  }
  for (const [key, value] of Object.entries(existing)) {
    if (MANAGED_KEYS.has(key) || emitted.has(key)) continue;
    const safeKey = sanitizeKey(key);
    if (!safeKey) continue; // 非法键名（含空白/特殊字符）：跳过，不写回
    lines.push("");
    lines.push(`${safeKey}=${sanitizeValue(value)}`);
  }

  return lines.join("\n") + "\n";
}

/**
 * 把单个键值对写入 .env 内容：已有该键则原位替换，没有则追加到末尾。
 * 纯字符串操作（文件读写由调用方完成），供运行期持久化单个配置（如 /model 切换）使用。
 * 值经转义：换行折叠为空格，避免破坏逐行解析。
 */
export function upsertEnvLine(content: string, key: string, value: string): string {
  const line = `${key}=${sanitizeValue(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, line);
  const base = content.trimEnd();
  return base ? `${base}\n${line}\n` : `${line}\n`;
}
