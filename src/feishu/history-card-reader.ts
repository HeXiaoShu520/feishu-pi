import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { join } from "node:path";
import { cardMentionNames, cardReferenceId, cardVisibleText, expandCardMentions } from "./inbound-content.ts";
import { LarkCli } from "./lark-cli.ts";

interface MessageItem {
  body?: { content?: string };
  mentions?: Array<{ name?: string; id?: { open_id?: string } | string }>;
}

/** 使用执行历史命令的同一身份读取卡片：用户命令用该用户令牌，--as bot 用当前应用凭证。 */
export function createHistoryCardReader(options: { cwd: string; appId: string; appSecret: string; userToken?: string }): (messageId: string) => Promise<string | undefined> {
  const botClient = options.userToken ? undefined : new Client({
    appId: options.appId,
    appSecret: options.appSecret,
    loggerLevel: LoggerLevel.error,
  });
  const profiles = new LarkCli(options.appId, join(options.cwd, "data", "users"));
  const get = async (path: string): Promise<Record<string, unknown>> => {
    if (options.userToken) {
      const response = await fetch(`https://open.feishu.cn${path}`, {
        headers: { Authorization: `Bearer ${options.userToken}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`卡片读取 HTTP ${response.status}`);
      return await response.json() as Record<string, unknown>;
    }
    return await botClient!.request({ method: "GET", url: path }) as Record<string, unknown>;
  };
  return async (messageId: string) => {
    if (!/^om_[A-Za-z0-9_-]+$/.test(messageId)) return undefined;
    const response = await get(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}?card_msg_content_type=user_card_content`);
    if (response.code !== 0) throw new Error(`卡片消息读取失败：${String(response.code)}`);
    const data = response.data as { items?: MessageItem[] } | undefined;
    const item = data?.items?.find((entry) => Boolean(entry.body?.content));
    const content = item?.body?.content;
    if (!content) return undefined;
    let visible = cardVisibleText(content);
    const cardId = cardReferenceId(content);
    if (!visible && cardId && /^[A-Za-z0-9_-]+$/.test(cardId)) {
      const card = await get(`/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}`);
      if (card.code === 0) {
        const cardData = card.data as { card?: unknown } | undefined;
        visible = cardVisibleText(JSON.stringify(cardData?.card ?? cardData ?? {}));
      }
    }
    if (!visible) return undefined;
    const names = cardMentionNames(content);
    for (const mention of item.mentions ?? []) {
      const id = typeof mention.id === "string" ? mention.id : mention.id?.open_id;
      if (id && mention.name) names.set(id, mention.name);
    }
    const ids = [...new Set([...visible.matchAll(/<at\s+(?:id|user_id)=["']?(ou_[A-Za-z0-9_-]+)/gi)].map((match) => match[1]))].slice(0, 20);
    await Promise.all(ids.map(async (id) => {
      const profile = await profiles.getUserProfile(id);
      if (profile.name || profile.en_name) names.set(id, profile.name || profile.en_name || id);
    }));
    return expandCardMentions(visible, names);
  };
}
