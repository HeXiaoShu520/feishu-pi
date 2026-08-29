import type { FeishuPiPrompt, FeishuPiSession } from "./types.ts";
import type { FeishuPiRuntime } from "./feishu-pi-runtime.ts";
import type { ConversationStore } from "./conversation-store.ts";

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
  private readonly conversations = new Map<string, Promise<ConversationState>>();
  private readonly runtime: FeishuPiRuntime;
  private readonly store?: ConversationStore;

  constructor(runtime: FeishuPiRuntime, store?: ConversationStore) {
    this.runtime = runtime;
    this.store = store;
  }

  /** 获取或创建一个会话，并合并并发的首次初始化。 */
  private getState(conversationId: string): Promise<ConversationState> {
    const existing = this.conversations.get(conversationId);
    if (existing) return existing;
    const initialization = this.initializeState(conversationId);
    this.conversations.set(conversationId, initialization);
    return initialization;
  }

  /** 从持久化映射恢复 Pi Session，失败时创建新 Session。 */
  private async initializeState(conversationId: string): Promise<ConversationState> {
    const sessionFile = await this.store?.get(conversationId);
    let session = sessionFile ? await this.runtime.createSession(sessionFile).catch(() => undefined) : undefined;
    if (!session) session = await this.runtime.createSession();
    if (session.sessionFile) await this.store?.set(conversationId, session.sessionFile);
    return { session, queue: Promise.resolve() };
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
