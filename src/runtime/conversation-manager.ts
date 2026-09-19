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
  /** 当前是否有在途/排队中的请求（新消息到达时据此打断；evictIdle 据此跳过） */
  busy?: boolean;
  /** 已从会话表移除（clear/evict）：孤儿任务不得再把 sessionFile 写回映射 */
  detached?: boolean;
  /** 最近一次活跃时刻（epoch 毫秒）：空闲驱逐的依据 */
  lastActiveAt: number;
  /** 已持久化到 store 的 sessionFile，避免重复写入 */
  persistedSessionFile?: string;
  /** 本轮 prompt 的打断回调：会话被打断（新消息/stop）时通知 bridge 撤回复卡 */
  onInterrupted?: () => void;
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

  /** 当前驻留内存的会话数（监控与测试用）。 */
  get size(): number {
    return this.conversations.size;
  }

  /**
   * 驱逐空闲会话，释放内存中的 Pi Session（历史在磁盘上，下次消息到达自动从 sessionFile 恢复）。
   * 忙碌（在途/排队中）的会话不驱逐。被驱逐的会话标记 detached——
   * 驱逐瞬间恰有任务在途时会变成孤儿（继续跑完回复），detached 阻止它把 sessionFile 写回映射，
   * 避免下一条消息恢复到已被驱逐的旧会话。返回驱逐数量。
   */
  async evictIdle(maxIdleMs: number, now = Date.now()): Promise<number> {
    let evicted = 0;
    for (const [id, statePromise] of this.conversations) {
      const state = await statePromise.catch(() => undefined);
      if (!state || state.busy || state.detached) continue;
      if (now - state.lastActiveAt < maxIdleMs) continue;
      state.detached = true;
      this.conversations.delete(id);
      evicted++;
    }
    if (evicted > 0) logger.info(`[Conversation] 已驱逐 ${evicted} 个空闲会话（空闲 ≥ ${Math.round(maxIdleMs / 60_000)} 分钟）`);
    return evicted;
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
    // 从上下文取用户身份（权限组判定依据）；上下文缺失属异常路径，仅作兜底
    const userId = context?.userOpenId ?? conversationId.split("-")[0];

    const sessionFile = await this.store?.get(conversationId);
    let session = sessionFile ? await this.runtime.createSession(sessionFile, userId, context).catch(() => undefined) : undefined;
    if (!session) session = await this.runtime.createSession(undefined, userId, context);
    const state: ConversationState = { session, queue: Promise.resolve(), lastActiveAt: Date.now() };
    await this.persistSessionFile(conversationId, state);
    return state;
  }

  /** sessionFile 一旦可用（Pi 首次落盘）立即持久化映射，不等整轮完成；
   *  孤儿会话（已 detached）跳过——否则 /new 或 evict 清掉的映射会被在途任务写回。 */
  private async persistSessionFile(conversationId: string, state: ConversationState): Promise<void> {
    if (state.detached) return;
    const file = state.session.sessionFile;
    if (file && file !== state.persistedSessionFile) {
      state.persistedSessionFile = file;
      await this.store?.set(conversationId, file);
    }
  }

  /** 排队执行一次消息，并将 Session 事件交给调用方。新消息打断在途请求时回调 onInterrupted。 */
  async prompt(
    message: ConversationMessage,
    onEvent: Parameters<FeishuPiSession["subscribe"]>[0],
    onInterrupted?: () => void,
  ): Promise<FeishuPiSession> {
    const state = await this.getState(message.conversationId, message.context);

    // 新消息打断：当前还在思考/执行时，先中断在途请求，本条消息排队后立即开始
    if (state.busy) {
      logger.info(`[Conversation] 新消息打断在途响应: ${message.conversationId}`);
      state.onInterrupted?.();
      state.session.abort();
    }
    // 立即标记占用：覆盖"getState 返回到 task 启动"之间的窗口——
    // 该窗口内 evictIdle 会把空闲会话驱逐成孤儿（跑完却不写回映射，下一条消息另建新会话）
    state.busy = true;
    state.onInterrupted = onInterrupted;

    const task = state.queue.then(async () => {
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
        state.lastActiveAt = Date.now();
        state.onInterrupted = undefined;
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

  /** 清空指定会话的历史记录：移除映射、中断在途任务并标记 detached——
   *  在途任务会跑完（回复仍送达），但不再把旧 sessionFile 写回映射，否则 /new 会被它抵消。 */
  async clear(conversationId: string): Promise<void> {
    const statePromise = this.conversations.get(conversationId);
    this.conversations.delete(conversationId);
    await this.store?.delete(conversationId);
    if (statePromise) {
      const state = await statePromise.catch(() => undefined);
      if (state) {
        state.detached = true;
        state.session.abort();
      }
    }
  }

  /** 中断指定会话的当前响应（/stop）：通知 bridge 撤回复卡后再 abort */
  async abort(conversationId: string): Promise<void> {
    const statePromise = this.conversations.get(conversationId);
    if (!statePromise) return;
    const state = await statePromise;
    state.onInterrupted?.();
    state.session.abort();
  }
}
