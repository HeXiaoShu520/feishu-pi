/**
 * 飞书接入层的接口定义：入站消息、回复句柄、传输层。
 */
import type { FeishuPiEvent, FeishuPiPrompt } from "../runtime/types.ts";

import type { FeishuContext } from "../context/types.ts";

/** 一条从飞书收到的入站消息（已过滤 @机器人 标记、已附带用户上下文）。 */
export interface FeishuInboundMessage {
  /** 飞书消息 ID，用于去重和回复定位 */
  messageId: string;
  /** 收到消息的会话 ID（群或私聊） */
  chatId: string;
  /** 用户上下文（发起者、话题、conversationId 等） */
  context: FeishuContext;
  /** 清洗后的文本内容 */
  text: string;
  /** 图片附件（如有） */
  images?: FeishuPiPrompt["images"];
}

/** 一次回复的生命周期句柄：流式更新正文，close 时收尾并写统计小字。 */
export interface FeishuReply {
  /** 追加增量文本 */
  update(text: string): Promise<void>;
  /** 结束回复；statsText 可选，作为统计小字 */
  close(text: string, statsText?: string): Promise<void>;
}

/** 飞书传输层抽象：长连接管理 + 消息订阅。 */
export interface FeishuTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: (message: FeishuInboundMessage) => Promise<void>): void;
}

/** Pi 会话事件的转发回调（assistant_text / tool_started 等）。 */
export type FeishuEventHandler = (event: FeishuPiEvent, message: FeishuInboundMessage) => void | Promise<void>;
