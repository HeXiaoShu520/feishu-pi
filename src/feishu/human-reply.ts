/**
 * 拟人化回复：短回复拆成几条普通文本消息，带一点"正在打字"的等待。
 *
 * 真人聊天是一条一条发短句，不是一张卡片一次性铺满屏。长内容、代码、
 * 表格和需要嵌入图片的回复仍走 CardKit 卡片，这里只负责轻量闲聊。
 */

import { randomUUID } from "node:crypto";

const MAX_PARTS = 3;
const MARKDOWN = /```|^\s*[-*]\s|\*\*|^#{1,3}\s|^\s*>\s|\[[^\]]+\]\([^)]+\)|^\s*\|.*\|\s*$|<at\b/m;

/** 需要卡片承载的回复：代码、列表、表格、链接、@ 标签、图片嵌入或篇幅过长。
 *  普通文本消息不渲染 Markdown 和 `<at>`，这些必须走卡片。 */
export function shouldUseCard(text: string): boolean {
  return text.trim().length > 260 || MARKDOWN.test(text);
}

/** 按段落和句末标点切成 1~3 条短消息；过短的相邻句合并。 */
export function splitHumanReply(text: string, max = MAX_PARTS): string[] {
  const raw = text.trim();
  if (!raw) return [];
  const out: string[] = [];
  for (const paragraph of raw.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)) {
    if ([...paragraph].length <= 90) {
      out.push(paragraph);
      continue;
    }
    const sentences = paragraph.split(/(?<=[。！？!?…~])\s*/).map((part) => part.trim()).filter(Boolean);
    out.push(...(sentences.length ? sentences : [paragraph]));
  }
  const merged: string[] = [];
  for (const part of out) {
    const last = merged[merged.length - 1];
    if (last && [...last].length < 8 && [...last].length + [...part].length <= 40) {
      merged[merged.length - 1] = `${last}${part}`;
    } else {
      merged.push(part);
    }
  }
  if (merged.length <= max) return merged;
  const head = merged.slice(0, max - 1);
  head.push(merged.slice(max - 1).join("\n"));
  return head;
}

/** 多个气泡之间留短暂停顿；首条不额外等待，也不模拟深夜困倦。 */
export function typingDelay(text: string, random: () => number = Math.random): number {
  const base = Math.min(1400, Math.max(350, [...text].length * 55));
  const jitter = 0.75 + random() * 0.5;
  return Math.round(base * jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把一条回复拆成多条飞书文本消息发出；返回实际发送条数。
 *  普通群/私聊直接发到会话（不带「回复 xx」引用），话题群才回进话题。 */
export async function sendHumanReply(
  client: {
    im: {
      message: {
        create(input: {
          params: { receive_id_type: "chat_id" };
          data: { receive_id: string; msg_type: string; content: string; uuid?: string };
        }): Promise<unknown>;
        reply(input: {
          path: { message_id: string };
          data: { msg_type: string; content: string; reply_in_thread: boolean };
        }): Promise<unknown>;
      };
    };
  },
  params: { chatId: string; messageId: string; text: string; replyInThread: boolean;
    sleep?: (ms: number) => Promise<void>;
    shouldContinue?: () => boolean;
    onDelivered?: (text: string) => void;
  },
): Promise<number> {
  const parts = splitHumanReply(params.text);
  const wait = params.sleep ?? sleep;
  let sent = 0;
  for (const part of parts) {
    if (params.shouldContinue?.() === false) break;
    if (sent > 0) await wait(typingDelay(part));
    if (params.shouldContinue?.() === false) break;
    const content = JSON.stringify({ text: part });
    let result: unknown;
    if (params.replyInThread) {
      result = await client.im.message.reply({
        path: { message_id: params.messageId },
        data: { msg_type: "text", content, reply_in_thread: true },
      });
    } else {
      result = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        // uuid 幂等：网络重试不会把同一句话发两遍。
        data: { receive_id: params.chatId, msg_type: "text", content, uuid: randomUUID() },
      });
    }
    const code = (result as { code?: number } | undefined)?.code;
    if (typeof code === "number" && code !== 0) throw new Error(`文本消息未送达：${code}`);
    sent += 1;
    params.onDelivered?.(part);
  }
  return sent;
}
