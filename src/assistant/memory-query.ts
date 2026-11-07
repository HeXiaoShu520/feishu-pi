/** Only treat explicit requests to review personal memories as an overview. */
export function isMemoryOverviewQuery(query: string): boolean {
  return /(?:记得|记住|知道|了解).{0,10}(?:我|我们).{0,10}(?:什么|哪些|多少|啥)|(?:关于我|对我).{0,10}(?:记得|记住|知道|了解).{0,10}(?:什么|哪些|多少|啥)|(?:我的|关于我).{0,8}(?:记忆|印象|画像)|what\s+do\s+you\s+(?:remember|know)\s+about\s+me/i.test(query);
}

export function isRecentConversationQuery(query: string): boolean {
  return /(?:上次|上回|之前|最近|前几天).{0,8}(?:我们|咱们|你我)?.{0,6}(?:聊|说|讨论).{0,8}(?:什么|啥|哪些|过什么)|(?:我们|咱们).{0,5}(?:上次|之前|最近).{0,5}(?:聊|说|讨论).{0,8}(?:什么|啥|哪些)/.test(query);
}

export function historySearchTopic(query: string): string {
  if (isRecentConversationQuery(query)) return "";
  const match = /(?:聊过|说过|讨论过|提过|讲过|说的|聊的)(.*)/.exec(query);
  if (!match || !/[我你咱]/.test(query.slice(0, match.index))) return "";
  const topic = match[1].replace(/^[\s\p{P}\p{S}]*(?:的|关于|有关|那个|那些)*/u, "")
    .replace(/(?:的话题|的事情|的事|吗|嘛|呢|啊|呀|么)+[\s\p{P}\p{S}]*$/u, "")
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "").trim();
  return /^(?:什么|哪些|啥|多少)$/.test(topic) ? "" : topic;
}

/** The timestamp marks when the fact was recorded, not when the event occurred. */
export function recordedDate(at: number): string {
  const date = new Date(at);
  return at > 0 && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "日期未知";
}

/** Interpret a small, explicit set of calendar windows in China time. */
export function historyTimeWindow(query: string, now = Date.now()): { start: number; end: number } | undefined {
  const shifted = new Date(now + 8 * 3600_000);
  const y = shifted.getUTCFullYear(), m = shifted.getUTCMonth(), d = shifted.getUTCDate();
  const utc = (year: number, month: number, day: number) => Date.UTC(year, month, day) - 8 * 3600_000;
  if (/上个月/.test(query)) return { start: utc(y, m - 1, 1), end: utc(y, m, 1) };
  if (/这个月|本月/.test(query)) return { start: utc(y, m, 1), end: utc(y, m + 1, 1) };
  if (/昨天/.test(query)) return { start: utc(y, m, d - 1), end: utc(y, m, d) };
  if (/今天/.test(query)) return { start: utc(y, m, d), end: utc(y, m, d + 1) };
  const date = /(20\d{2})年(\d{1,2})月/.exec(query);
  if (date && Number(date[2]) >= 1 && Number(date[2]) <= 12) return { start: utc(Number(date[1]), Number(date[2]) - 1, 1), end: utc(Number(date[1]), Number(date[2]), 1) };
  return undefined;
}
