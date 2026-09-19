import type { FeishuPiPrompt, FeishuPiSession, SessionStats } from "./types.ts";
import type { FeishuPiRuntime } from "./feishu-pi-runtime.ts";
import type { SessionStore } from "./session-store.ts";
import type { FeishuContext } from "../context/types.ts";
import { logger } from "../utils/logger.ts";

export interface ConversationMessage {
  conversationId: string;
  prompt: FeishuPiPrompt;
  context?: FeishuContext;  // 添加上下文信息
}

interface ConversationState {
  session: FeishuPiSession;
  /** 本代会话 id（/new 换代后旧状态仍带着旧 id，用于挡住旧会话文件写回新记录） */
  sessionId: string;
  queue: Promise<void>;
  /** 当前是否有在途/排队中的请求（新消息到达时据此打断；evictIdle 据此跳过） */
  busy?: boolean;
  /** 已从会话表移除（/new 换代或空闲驱逐）：孤儿任务不得再把 sessionFile 写回注册表 */
  detached?: boolean;
  /** 最近一次活跃时刻（epoch 毫秒）：空闲驱逐的依据 */
  lastActiveAt: number;
  /** 已持久化到会话注册表的 sessionFile，避免重复写入 */
  persistedSessionFile?: string;
  /** 本轮 prompt 的打断回调：会话被打断（新消息/stop）时通知 bridge 撤回复卡 */
  onInterrupted?: () => void;
}

/** 管理聊天会话复用，并保证同一会话内的消息按顺序执行。
 * 每次会话（sessionId）对应磁盘上一个会话目录，由 SessionStore 登记与换代。 */
export class ConversationManager {
  private readonly conversations = new Map<string, Promise<ConversationState>>();
  /** 正在换代的会话（/new）：期间到达的消息先等换代完成，以免又落到旧会话目录 */
  private readonly rotating = new Map<string, Promise<void>>();
  private readonly runtime: FeishuPiRuntime;
  /** 会话注册表：会话目录与 Pi 会话文件都登记在这里（会话目录的唯一事实来源） */
  private readonly sessions: SessionStore;

  constructor(runtime: FeishuPiRuntime, sessions: SessionStore) {
    this.runtime = runtime;
    this.sessions = sessions;
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
  private async getState(conversationId: string, context?: FeishuContext): Promise<ConversationState> {
    // 换代（/new）进行中：先等换代落定，否则会把本次会话建在即将被换掉的旧目录里
    const rotating = this.rotating.get(conversationId);
    if (rotating) await rotating.catch(() => undefined);

    const existing = this.conversations.get(conversationId);
    if (existing) return existing;
    const initialization = this.initializeState(conversationId, context);
    this.conversations.set(conversationId, initialization);
    return initialization;
  }

  /** 从会话注册表恢复 Pi Session（历史在会话目录里），失败或没有历史时在该会话目录新建。 */
  private async initializeState(conversationId: string, context?: FeishuContext): Promise<ConversationState> {
    // 从上下文取用户身份（权限组判定依据）；上下文缺失属异常路径，仅作兜底
    const userId = context?.userOpenId ?? conversationId.split("-")[0];

    // 会话目录由注册表给定：/new 之后拿到的是新会话（新 id + 新目录 + 空历史）
    const record = await this.sessions.getOrCreate(conversationId);
    let session = record.sessionFile
      ? await this.runtime.createSession(record.sessionFile, userId, context).catch(() => undefined)
      : undefined;
    if (!session) session = await this.runtime.createSession(undefined, userId, context);
    const state: ConversationState = { session, sessionId: record.sessionId, queue: Promise.resolve(), lastActiveAt: Date.now() };
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
      await this.sessions.setSessionFile(conversationId, file, state.sessionId);
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

  /**
   * `/new`：换一代会话（新会话 id + 新目录 + 空历史），旧目录留在磁盘上等过期清理。
   * 在途任务会跑完（回复仍送达），但已 detached，且代次不符——不会把旧会话文件写回新记录。
   */
  async reset(conversationId: string): Promise<void> {
    const statePromise = this.conversations.get(conversationId);
    this.conversations.delete(conversationId);

    const task = (async () => {
      await this.sessions.rotate(conversationId);
      if (statePromise) {
        const state = await statePromise.catch(() => undefined);
        if (state) {
          state.detached = true;
          state.session.abort();
        }
      }
    })();
    this.rotating.set(conversationId, task);
    try {
      await task;
    } finally {
      if (this.rotating.get(conversationId) === task) this.rotating.delete(conversationId);
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
