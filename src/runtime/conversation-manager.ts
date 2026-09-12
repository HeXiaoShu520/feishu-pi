import type { FeishuPiPrompt, FeishuPiSession, SessionStats } from "./types.ts";
import type { FeishuPiRuntime } from "./feishu-pi-runtime.ts";
import type { ConversationStore } from "./conversation-store.ts";
import type { FeishuContext } from "../context/types.ts";
import { logger } from "../utils/logger.ts";

export interface ConversationMessage {
  conversationId: string;
  prompt: FeishuPiPrompt;
  context?: FeishuContext;  // 添加上下文信息
}

interface ConversationState {
  session: FeishuPiSession;
  queue: Promise<void>;
  /** 当前是否有在途请求（新消息到达时据此打断） */
  busy?: boolean;
  /** 已持久化到 store 的 sessionFile，避免重复写入 */
  persistedSessionFile?: string;
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
  private getState(conversationId: string, context?: FeishuContext): Promise<ConversationState> {
    const existing = this.conversations.get(conversationId);
    if (existing) return existing;
    const initialization = this.initializeState(conversationId, context);
    this.conversations.set(conversationId, initialization);
    return initialization;
  }

  /** 从持久化映射恢复 Pi Session，失败时创建新 Session。 */
  private async initializeState(conversationId: string, context?: FeishuContext): Promise<ConversationState> {
    // 从上下文取用户身份（权限组判定依据）；无上下文时按 conversationId 前缀反推
    // （仅对按用户隔离的 `{openId}-chat:...` 格式有效；topic: 会话必须依赖 context）
    const userId = context?.userOpenId ?? conversationId.split("-")[0];

    const sessionFile = await this.store?.get(conversationId);
    let session = sessionFile ? await this.runtime.createSession(sessionFile, userId, context).catch(() => undefined) : undefined;
    if (!session) session = await this.runtime.createSession(undefined, userId, context);
    const state: ConversationState = { session, queue: Promise.resolve() };
    await this.persistSessionFile(conversationId, state);
    return state;
  }

  /** sessionFile 一旦可用（Pi 首次落盘）立即持久化映射，不等整轮完成。 */
  private async persistSessionFile(conversationId: string, state: ConversationState): Promise<void> {
    const file = state.session.sessionFile;
    if (file && file !== state.persistedSessionFile) {
      state.persistedSessionFile = file;
      await this.store?.set(conversationId, file);
    }
  }

  /** 排队执行一次消息，并将 Session 事件交给调用方。新消息到达时会打断在途请求。 */
  async prompt(message: ConversationMessage, onEvent: Parameters<FeishuPiSession["subscribe"]>[0]): Promise<FeishuPiSession> {
    const state = await this.getState(message.conversationId, message.context);

    // 新消息打断：当前还在思考/执行时，先中断在途请求，本条消息排队后立即开始
    if (state.busy) {
      logger.info(`[Conversation] 新消息打断在途响应: ${message.conversationId}`);
      state.session.abort();
    }

    const task = state.queue.then(async () => {
      state.busy = true;
      // 事件到达时同步检查 sessionFile：Pi 在首个 message_end 落盘，此时立刻持久化映射，
      // 即使随后被中断，下次也能恢复到同一会话
      const unsubscribe = state.session.subscribe(async (event) => {
        await this.persistSessionFile(message.conversationId, state);
        await onEvent(event);
      });
      try {
        await state.session.prompt(message.prompt);
        await state.session.waitForIdle();
      } finally {
        state.busy = false;
        unsubscribe();
        // 兜底：响应结束后再检查一次
        await this.persistSessionFile(message.conversationId, state);
      }
    });
    state.queue = task.catch(() => undefined);
    await task;
    return state.session;
  }

  /** 获取指定会话当前的真实 Session 统计（不存在会创建会话）。 */
  async getStats(conversationId: string, context?: FeishuContext): Promise<SessionStats | undefined> {
    const state = await this.getState(conversationId, context);
    return state.session.getStats?.();
  }

  /** 清空指定会话的历史记录 */
  async clear(conversationId: string): Promise<void> {
    // 删除映射和持久化
    this.conversations.delete(conversationId);
    await this.store?.delete(conversationId);
  }

  /** 中断指定会话的当前响应 */
  async abort(conversationId: string): Promise<void> {
    const statePromise = this.conversations.get(conversationId);
    if (!statePromise) return;
    const state = await statePromise;
    state.session.abort();
  }
}
