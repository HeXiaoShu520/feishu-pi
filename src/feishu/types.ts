import type { FeishuPiEvent, FeishuPiPrompt } from "../runtime/types.ts";

import type { FeishuContext } from "../context/types.ts";

export interface FeishuInboundMessage {
  messageId: string;
  chatId: string;
  context: FeishuContext;
  text: string;
  images?: FeishuPiPrompt["images"];
}

export interface FeishuReply {
  update(text: string): Promise<void>;
  close(text: string): Promise<void>;
}

export interface FeishuTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: (message: FeishuInboundMessage) => Promise<void>): void;
  startReply(message: FeishuInboundMessage): Promise<FeishuReply>;
}

export type FeishuEventHandler = (event: FeishuPiEvent, message: FeishuInboundMessage) => void | Promise<void>;
