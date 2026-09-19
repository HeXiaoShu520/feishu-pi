/**
 * .env 单键写入工具：供运行期持久化单个配置（如 /model 切换）使用。
 * 纯字符串操作（文件读写由调用方完成）。
 */

/** 值必须是单行的：换行符折叠为空格，避免破坏 .env 逐行解析；控制字符剔除。 */
function sanitizeValue(value: string): string {
  return value.replace(/\r\n?/g, " ").replace(/\n/g, " ").replace(/[\0\b\f\v]/g, "");
}

/**
 * 把单个键值对写入 .env 内容：已有该键则原位替换，没有则追加到末尾。
 * 值经转义：换行折叠为空格，避免破坏逐行解析。
 */
export function upsertEnvLine(content: string, key: string, value: string): string {
  const line = `${key}=${sanitizeValue(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, () => line);
  const base = content.trimEnd();
  return base ? `${base}\n${line}\n` : `${line}\n`;
}
