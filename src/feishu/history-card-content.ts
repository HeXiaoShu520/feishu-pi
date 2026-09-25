import { annotatePeople, cardReferenceId, personLabel } from "./inbound-content.ts";

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

/** 只拦截消息读取命令；发送、编辑和其它 CLI 输出原样透传。 */
export function isFeishuHistoryRead(args: string[]): boolean {
  const words = args.filter((arg, index) => arg !== "--as" && args[index - 1] !== "--as" && !arg.startsWith("--as="));
  if (words[0] !== "im") return false;
  if (["+chat-messages-list", "+threads-messages-list", "+messages-mget", "+messages-search"].includes(words[1] ?? "")) return true;
  return words[1] === "messages" && ["get", "list"].includes(words[2] ?? "");
}

/** 在 CLI 历史结果中把 Card 2.0 的 card_id 占位内容换成可见原文，并保留发言人姓名和 ID。 */
export async function enrichFeishuHistory(
  output: string,
  fetchCard: (messageId: string) => Promise<string | undefined>,
  resolveSpeaker?: (senderId: string, senderType?: string) => Promise<string | undefined>,
): Promise<string> {
  let root: unknown;
  try { root = JSON.parse(output); } catch {
    const ids = [...new Set(output.split("\n")
      .filter((line) => /interactive|\[interactive card\]|卡片/i.test(line))
      .flatMap((line) => [...line.matchAll(/\bom_[A-Za-z0-9_-]+\b/g)].map((match) => match[0])))];
    const details: string[] = [];
    for (const id of ids) {
      const content = await fetchCard(id).catch(() => undefined);
      if (content) details.push(`[卡片 ${id} 原文]\n${content}`);
    }
    return details.length ? `${output.trimEnd()}\n\n${details.join("\n\n")}\n` : output;
  }
  const cards: Array<{ messageId: string; value: JsonRecord }> = [];
  const speakers: Array<{ value: JsonRecord; senderId: string; senderType?: string; senderName?: string }> = [];
  const visited = new Set<object>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 12 || !value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    const item = value as JsonRecord;
    const sender = object(item.sender);
    const senderId = typeof sender?.id === "string" ? sender.id : undefined;
    if (senderId) {
      const senderName = typeof sender?.name === "string" ? sender.name : typeof sender?.sender_name === "string" ? sender.sender_name : undefined;
      speakers.push({ value: item, senderId, senderType: typeof sender?.sender_type === "string" ? sender.sender_type : undefined, senderName });
    }
    if (Array.isArray(item.mentions)) {
      const people = item.mentions.flatMap((entry): Array<{ openId: string; name: string }> => {
        const mention = object(entry);
        const idValue = mention?.id;
        const openId = typeof idValue === "string" ? idValue : object(idValue)?.open_id;
        const name = mention?.name;
        return typeof openId === "string" && typeof name === "string" && /^ou_[A-Za-z0-9_-]+$/.test(openId)
          ? [{ openId, name }] : [];
      });
      if (typeof item.content === "string") item.content = annotatePeople(item.content, people);
      const body = object(item.body);
      if (body && typeof body.content === "string") body.content = annotatePeople(body.content, people);
    }
    const type = item.msg_type ?? item.message_type;
    const messageId = item.message_id;
    if (type === "interactive" && typeof messageId === "string" && /^om_[A-Za-z0-9_-]+$/.test(messageId)) {
      cards.push({ messageId, value: item });
    }
    for (const nested of Object.values(item)) walk(nested, depth + 1);
  };
  walk(root, 0);
  const resolvedNames = new Map<string, string | undefined>();
  const unknownSpeakers = new Map(speakers.filter((speaker) => !speaker.senderName)
    .map((speaker) => [`${speaker.senderType ?? ""}:${speaker.senderId}`, speaker]));
  await Promise.all([...unknownSpeakers].map(async ([key, { senderId, senderType }]) => {
    resolvedNames.set(key, resolveSpeaker ? await resolveSpeaker(senderId, senderType).catch(() => undefined) : undefined);
  }));
  for (const { value, senderId, senderType, senderName } of speakers) {
    value.speaker = personLabel(senderName || resolvedNames.get(`${senderType ?? ""}:${senderId}`), senderId);
  }
  const cardContent = new Map<string, string | undefined>();
  const ids = [...new Set(cards.map((card) => card.messageId))];
  for (let index = 0; index < ids.length; index += 5) {
    await Promise.all(ids.slice(index, index + 5).map(async (id) => {
      cardContent.set(id, await fetchCard(id).catch(() => undefined));
    }));
  }
  for (const card of cards) {
    const content = cardContent.get(card.messageId);
    if (content) card.value.content = `[卡片内容]\n${content}`;
    else if (cardContent.has(card.messageId)) {
      const oldContent = typeof card.value.content === "string" ? card.value.content.trim() : "";
      if (!oldContent || /^\[interactive card\]$|^<card|^\[卡片\]$/i.test(oldContent) || cardReferenceId(oldContent)) {
        card.value.content = `[卡片 ${card.messageId}：原文暂时无法读取]`;
      }
    }
    const body = object(card.value.body);
    if (body && typeof card.value.content === "string") body.content = card.value.content;
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}
