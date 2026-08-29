import type { FeishuPiPrompt, FeishuPiSession } from "./types.ts";
import type { FeishuPiRuntime } from "./feishu-pi-runtime.ts";

export interface ConversationMessage {
  conversationId: string;
  prompt: FeishuPiPrompt;
}

interface ConversationState {
  session: FeishuPiSession;
  queue: Promise<void>;
}

/** 管理聊天会话复用，并保证同一会话内的消息按顺序执行。 */
export class ConversationManager {
  private readonly conversations = new Map<string, ConversationState>();
  private readonly runtime: FeishuPiRuntime;

  constructor(runtime: FeishuPiRuntime) {
    this.runtime = runtime;
  }

  /** 获取或创建一个会话。 */
  private async getState(conversationId: string): Promise<ConversationState> {
    const existing = this.conversations.get(conversationId);
    if (existing) return existing;
    const state: ConversationState = {
      session: await this.runtime.createSession(),
      queue: Promise.resolve(),
    };
    this.conversations.set(conversationId, state);
    return state;
  }

  /** 排队执行一次消息，并将 Session 事件交给调用方。 */
  async prompt(message: ConversationMessage, onEvent: Parameters<FeishuPiSession["subscribe"]>[0]): Promise<void> {
    const state = await this.getState(message.conversationId);
    const task = state.queue.then(async () => {
      const unsubscribe = state.session.subscribe(onEvent);
      try {
        await state.session.prompt(message.prompt);
        await state.session.waitForIdle();
      } finally {
        unsubscribe();
      }
    });
    state.queue = task.catch(() => undefined);
    await task;
  }
}
