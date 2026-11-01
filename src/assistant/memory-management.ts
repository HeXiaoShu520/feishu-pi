export interface ManagedMemory {
  id: string;
  category: string;
  text: string;
  active: boolean;
}

export type MemoryManagementAction = "list" | "disable" | "restore";

export function findMemory<T extends { id: string }>(items: T[], prefix: string): T {
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(prefix)) throw new Error("请提供列表中的记忆 ID（至少 6 位）");
  const matches = items.filter(item => item.id.startsWith(prefix));
  if (matches.length !== 1) throw new Error(matches.length ? "ID 不唯一，请使用更长的 ID" : "没有找到该记忆");
  return matches[0];
}
