/**
 * 会话 ID 短别名管理
 * 完整会话 ID 过长，卡片小字只展示短别名，内部维护 别名 → 完整ID 的映射。
 */

/** 别名长度（取完整 ID 去掉连字符后的前 8 位） */
const ALIAS_LENGTH = 8;

/** 别名 → 完整会话 ID 的映射表 */
const aliasToSessionId = new Map<string, string>();

/**
 * 获取会话 ID 的短别名；同一完整 ID 永远映射到同一别名。
 * @param sessionId 完整会话 ID
 * @returns 短别名（如 01a05e14），完整 ID 为空时返回"未知"
 */
export function sessionAlias(sessionId?: string): string {
  if (!sessionId) return "未知";
  // 复用已登记的别名，保证同一会话显示稳定
  for (const [alias, full] of aliasToSessionId) {
    if (full === sessionId) return alias;
  }
  // 去掉连字符后取前 8 位作为别名；冲突时追加后缀
  const base = sessionId.replace(/-/g, "").slice(0, ALIAS_LENGTH) || "未知";
  let alias = base;
  let suffix = 1;
  while (aliasToSessionId.has(alias) && aliasToSessionId.get(alias) !== sessionId) {
    alias = `${base}-${suffix++}`;
  }
  aliasToSessionId.set(alias, sessionId);
  return alias;
}

