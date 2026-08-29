/** 根据飞书会话和话题生成稳定的 Pi 会话 ID。 */
export function createConversationId(chatId: string, threadId?: string): string {
  return threadId ? `${chatId}:thread:${threadId}` : `chat:${chatId}`;
}
