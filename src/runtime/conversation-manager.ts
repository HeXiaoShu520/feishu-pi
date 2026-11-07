import type { FeishuPiPrompt, FeishuPiSession } from "./types.ts";
import type { FeishuPiRuntime } from "./feishu-pi-runtime.ts";
import type { SessionStore } from "./session-store.ts";
import type { FeishuContext } from "./types.ts";
import { logger } from "../utils/logger.ts";

export interface ConversationMessage {
  conversationId: string;
  prompt: FeishuPiPrompt;
  /** 调用者身份（权限组判定、会话目录归属的依据）：消息入口必附，缺失属装配错误而非运行时兜底 */
  context: FeishuContext;
}

/** 打断原因：new-message=新消息到达且收尾窗口超时；stop=/stop；reset=/new 换代。 */
export type InterruptReason = "new-message" | "stop" | "reset";

interface ConversationState {
  session: FeishuPiSession;
  /** 本代会话 id（/new 换代后旧状态仍带着旧 id，用于挡住旧会话文件写回新记录） */
  sessionId: string;
  queue: Promise<void>;
  /** 当前是否有在途/排队中的请求（新消息到达时据此打断；evictIdle 据此跳过） */
  pending: number;
  userId: string;
  /** 已从会话表移除（/new 换代或空闲驱逐）：孤儿任务不得再把 sessionFile 写回注册表 */
  detached?: boolean;
  /** 最近一次活跃时刻（epoch 毫秒）：空闲驱逐的依据 */
  lastActiveAt: number;
  /** 已持久化到会话注册表的 sessionFile，避免重复写入 */
  persistedSessionFile?: string;
  /** 本轮 prompt 的打断回调：会话被打断（新消息/stop）时通知 bridge 撤回复卡或定格说明 */
  onInterrupted?: (reason: InterruptReason) => void;
  /** 当前在途任务的收尾信号（任务体开始时创建，finally 全部收尾后 resolve）：
   *  新消息到达时限时等待它，窗口内自然完成则无需硬打断 */
  inflight?: Promise<void>;
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
  /** 单个会话允许保留的在途/排队消息数，防止突发消息无限堆积。 */
  private readonly maxPendingMessages: number;
  /** 新消息打断前的收尾窗口（毫秒）：窗口内旧任务自然完成则不打断，超时才硬 abort。 */
  private readonly interruptGraceMs: number;

  constructor(runtime: FeishuPiRuntime, sessions: SessionStore, options: { maxPendingMessages?: number; interruptGraceMs?: number } = {}) {
    this.runtime = runtime;
    this.sessions = sessions;
    this.maxPendingMessages = Math.max(1, options.maxPendingMessages ?? 3);
    this.interruptGraceMs = Math.max(1, options.interruptGraceMs ?? 5_000);
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
      if (!state || state.pending || state.detached || this.conversations.get(id) !== statePromise) continue;
      if (now - state.lastActiveAt < maxIdleMs) continue;
      state.detached = true;
      this.conversations.delete(id);
      evicted++;
    }
    if (evicted > 0) logger.info(`[Conversation] 已驱逐 ${evicted} 个空闲会话（空闲 ≥ ${Math.round(maxIdleMs / 60_000)} 分钟）`);
    return evicted;
  }

  /** 获取或创建一个会话，并合并并发的首次初始化。 */
  private async getState(conversationId: string, context: FeishuContext): Promise<ConversationState> {
    // 换代（/new）进行中：先等换代落定，否则会把本次会话建在即将被换掉的旧目录里
    const rotating = this.rotating.get(conversationId);
    if (rotating) await rotating.catch(() => undefined);

    const existing = this.conversations.get(conversationId);
    if (existing) return existing;
    const initialization = this.initializeState(conversationId, context).catch((error) => {
      if (this.conversations.get(conversationId) === initialization) this.conversations.delete(conversationId);
      throw error;
    });
    this.conversations.set(conversationId, initialization);
    return initialization;
  }

  /** 从会话注册表恢复 Pi Session（历史在会话目录里），失败或没有历史时在该会话目录新建。 */
  private async initializeState(conversationId: string, context: FeishuContext): Promise<ConversationState> {
    // 用户身份（权限组判定依据）：入口必附上下文，编译期保证，不再从 conversationId 伪造
    const userId = context.userOpenId;

    // 会话目录由注册表给定：/new 之后拿到的是新会话（新 id + 新目录 + 空历史）
    const record = await this.sessions.getOrCreate(conversationId, context.userOpenId);
    let session = record.sessionFile
      ? await this.runtime.createSession(record.sessionFile, userId, context).catch(() => undefined)
      : undefined;
    if (!session) session = await this.runtime.createSession(undefined, userId, context);
    const state: ConversationState = { session, sessionId: record.sessionId, userId, pending: 0, queue: Promise.resolve(), lastActiveAt: Date.now() };
    await this.persistSessionFile(conversationId, state);
    return state;
  }

  /** sessionFile 一旦可用（Pi 首次落盘）立即持久化映射，不等整轮完成；
   *  孤儿会话（已 detached）跳过——否则 /new 或 evict 清掉的映射会被在途任务写回。 */
  private async persistSessionFile(conversationId: string, state: ConversationState): Promise<void> {
    if (state.detached) return;
    const file = state.session.sessionFile;
    if (file && file !== state.persistedSessionFile) {
      await this.sessions.setSessionFile(conversationId, file, state.sessionId);
      state.persistedSessionFile = file;
    }
  }

  /** 排队执行一次消息，并将 Session 事件交给调用方。新消息打断在途请求时回调 onInterrupted（带打断原因）。 */
  async prompt(
    message: ConversationMessage,
    onEvent: Parameters<FeishuPiSession["subscribe"]>[0],
    onInterrupted?: (reason: InterruptReason) => void,
  ): Promise<FeishuPiSession> {
    const state = await this.getState(message.conversationId, message.context);

    if (state.pending >= this.maxPendingMessages) {
      throw new Error(`当前会话已有 ${state.pending} 条消息在处理或排队，请稍后再试`);
    }

    // 新消息打断：先给在途任务一个收尾窗口——窗口内自然完成则旧回复卡完整定格、
    // 工具原子操作不被拦腰砍断；超时才硬 abort 并通知 bridge 定格中止说明。
    // 排队中的消息没有可等的在途任务（inflight 为空），直接排队。
    if (state.pending && state.inflight) {
      logger.info(`[Conversation] 新消息到达，等待在途响应收尾（最多 ${this.interruptGraceMs}ms）: ${message.conversationId}`);
      let graceTimer: NodeJS.Timeout | undefined;
      const finished = await Promise.race([
        state.inflight.then(() => true, () => true),
        new Promise<false>((resolve) => { graceTimer = setTimeout(() => resolve(false), this.interruptGraceMs); }),
      ]);
      if (graceTimer) clearTimeout(graceTimer);
      if (finished) {
        logger.info(`[Conversation] 在途响应已在窗口内收尾，新消息不打断: ${message.conversationId}`);
      } else {
        logger.info(`[Conversation] 收尾窗口超时，硬中断在途响应: ${message.conversationId}`);
        state.onInterrupted?.("new-message");
        state.session.abort();
      }
    }
    // 立即标记占用：覆盖"getState 返回到 task 启动"之间的窗口——
    // 该窗口内 evictIdle 会把空闲会话驱逐成孤儿（跑完却不写回映射，下一条消息另建新会话）
    state.pending++;

    const task = state.queue.then(async () => {
      // 在途收尾信号：任务真正开始执行才创建（排队中的不算在途），finally 全部收尾后放行
      let finishInflight = () => {};
      state.inflight = new Promise<void>((resolve) => { finishInflight = resolve; });
      let unsubscribe = () => {};
      let events = Promise.resolve();
      try {
        if (state.detached) throw new Error("会话已重置，请重新发送消息");
        const userId = message.context.userOpenId;
        // 话题共享历史，但工具闭包绑定用户。换人时在队列内重建运行时，避免借用前一人的凭证。
        if (state.userId !== userId) {
          if (message.context.chatMode === "p2p") throw new Error("私聊会话身份不匹配，拒绝复用历史记录");
          state.session = await this.runtime.createSession(state.session.sessionFile, userId, message.context);
          state.userId = userId;
        }
        state.onInterrupted = onInterrupted;
        unsubscribe = state.session.subscribe((event) => {
          // Pi 不等待订阅回调；串行消费并在本轮结束前排空，防终态卡片早于正文。
          events = events.then(async () => {
            await this.persistSessionFile(message.conversationId, state);
            await onEvent(event);
          });
          void events.catch(() => {}); // 由下面的 await events 向调用方报告错误
        });
        await state.session.prompt(message.prompt);
        await state.session.waitForIdle();
        return state.session;
      } finally {
        unsubscribe();
        try {
          await events;
          await this.persistSessionFile(message.conversationId, state);
        } finally {
          state.pending--;
          state.lastActiveAt = Date.now();
          state.onInterrupted = undefined;
          finishInflight();
          state.inflight = undefined;
        }
      }
    });
    state.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  /**
   * `/new`：换一代会话（新会话 id + 新目录 + 空历史），旧目录留在磁盘上等过期清理。
   * 在途任务会跑完（回复仍送达），但已 detached，且代次不符——不会把旧会话文件写回新记录。
   */
  async reset(conversationId: string, callerOpenId?: string): Promise<void> {
    const statePromise = this.conversations.get(conversationId);
    this.conversations.delete(conversationId);

    const previous = this.rotating.get(conversationId) ?? Promise.resolve();
    const task = previous.then(async () => {
      if (statePromise) {
        const state = await statePromise.catch(() => undefined);
        if (state) {
          state.detached = true;
          state.onInterrupted?.("reset");
          state.session.abort();
        }
      }
      await this.sessions.rotate(conversationId, callerOpenId);
    });
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
    state.onInterrupted?.("stop");
    state.session.abort();
  }
}
