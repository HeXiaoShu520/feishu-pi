/**
 * 最近发送记录：同一张表情短时间别反复刷屏。
 * 进程内状态，重启清零；只降权不排除，保证搜索结果凑得满 limit。
 * 记录全局不分 chat：私聊和群里共享一份"最近"——单用户个人 Agent 场景
 * 可接受，若未来多租户再按 chatId 分桶。
 */

const recent: string[] = [];

/** 记住的数量：一次会话自然发送量在个位数，8 条足够覆盖"最近"语义 */
const MAX = 8;

export function recordSent(id: string): void {
  const index = recent.indexOf(id);
  if (index >= 0) recent.splice(index, 1);
  recent.unshift(id);
  if (recent.length > MAX) recent.length = MAX;
}

export function recentSent(): readonly string[] {
  return recent;
}

/** 越新压得越狠：刚发过 ×0.3，往回线性回升，出列后恢复 ×1 */
export function sentPenalty(id: string, order: readonly string[] = recent): number {
  const index = order.indexOf(id);
  if (index < 0) return 1;
  return 0.3 + 0.05 * index;
}
