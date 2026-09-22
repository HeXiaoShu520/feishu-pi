/**
 * 定时任务服务：cron 调度（croner）+ 文件持久化 + 触发执行。
 *
 * 职责分界：本模块只管"何时触发、任务存档、状态记录"；触发后跑什么由 main 注入的
 * runTask 决定（跑智能体并把结果卡片推回目标会话，复用既有会话链路与权限闸门）。
 * 任务以创建者身份执行——权限判定发生在执行中的每一次工具调用（ToolGuard），
 * 调度本身不做权限判断。
 */
import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.ts";
import { JsonMapStore } from "../utils/json-store.ts";

/** 一个定时任务 */
export interface ScheduleTask {
  id: string;
  /** 任务名（展示用） */
  name: string;
  /** cron 表达式（5 段：分 时 日 月 周）；非 cron 任务为空字符串，保留此字段兼容旧档案。 */
  cron: string;
  /** 调度形式；旧档案没有该字段时按 cron 处理。 */
  kind?: "cron" | "at" | "every";
  /** 一次性任务的 ISO 8601 时间。 */
  at?: string;
  /** 固定间隔任务的毫秒数。 */
  everyMs?: number;
  /** cron 任务使用的 IANA 时区；未填写时使用服务进程本地时区。 */
  timezone?: string;
  /** 触发时投给智能体的指令 */
  prompt: string;
  /** 结果推送的目标会话（创建任务时的飞书会话） */
  chatId: string;
  /** 创建者 openId（任务以其身份与权限执行） */
  createdBy: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
}

/**
 * 定时任务持久化：复用 JsonMapStore 的懒加载 + 串行原子写框架（id → 任务）。
 */
export class ScheduleStore extends JsonMapStore<ScheduleTask> {
  /** 全部任务，按创建时间升序（展示顺序稳定）。 */
  async list(): Promise<ScheduleTask[]> {
    await this.ensureLoaded();
    return [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<ScheduleTask | undefined> {
    await this.ensureLoaded();
    return this.records.get(id);
  }

  async put(task: ScheduleTask): Promise<void> {
    await this.ensureLoaded();
    this.records.set(task.id, task);
    await this.persist();
  }

  /** 仅当任务仍存在时写入（防后台执行把刚删除的任务写回复活）。 */
  async putIfPresent(task: ScheduleTask): Promise<boolean> {
    return this.writeIfPresent(task.id, task);
  }

  /** 删除任务；返回是否存在（供回执文案）。 */
  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const existed = this.records.delete(id);
    if (existed) await this.persist();
    return existed;
  }
}

export interface ScheduleServiceOptions {
  /** 任务持久化文件路径（data/schedules.json） */
  storeFile: string;
  /** 触发执行：运行智能体并把结果卡片推回目标会话（由 main 注入，复用会话链路与飞书传输） */
  runTask: (task: ScheduleTask) => Promise<void>;
}

/**
 * 定时任务调度器：启动时恢复全部在期任务的 cron，触发时执行注入的 runTask。
 * - 同一任务触发时若上一轮未结束，跳过本次触发；
 * - 执行结果（成功/失败）记入任务档案，供查询指令展示。
 */
export class ScheduleService {
  private readonly store: ScheduleStore;
  /** 运行中的调度任务（任务 id → croner 或原生 timer）。 */
  private readonly jobs = new Map<string, { stop: () => void }>();
  private readonly runTask: (task: ScheduleTask) => Promise<void>;
  private readonly running = new Set<string>();
  private started = false;

  constructor(options: ScheduleServiceOptions) {
    this.store = new ScheduleStore(options.storeFile);
    this.runTask = options.runTask;
  }

  /** 启动：恢复所有已启用任务的调度（服务启动后调用一次）。 */
  async start(): Promise<void> {
    this.started = true;
    for (const task of await this.store.list()) {
      if (task.enabled) this.scheduleJob(task);
    }
    logger.info(`[Schedule] 定时任务调度已启动，共 ${this.jobs.size} 个在期任务`);
  }

  /** 停止全部调度（优雅退出时调用）。 */
  stop(): void {
    this.started = false;
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  /** 新建任务：校验 cron / at / every，持久化并上调度。返回 { task } 或 { error }。 */
  async addTask(input: {
    cron: string;
    prompt: string;
    chatId: string;
    createdBy: string;
    name?: string;
    kind?: "cron" | "at" | "every";
    at?: string;
    everyMs?: number;
    timezone?: string;
  }): Promise<{ task?: ScheduleTask; error?: string }> {
    const kind = input.kind ?? (input.at ? "at" : input.everyMs !== undefined ? "every" : "cron");
    if (kind !== "cron" && kind !== "at" && kind !== "every") return { error: `不支持的调度类型：${String(kind)}` };
    const cron = input.cron.trim();
    const timezone = input.timezone?.trim() || undefined;
    const validationError = this.validateSchedule({ kind, cron, at: input.at, everyMs: input.everyMs, timezone });
    if (validationError) return { error: validationError };
    if (!input.prompt.trim()) return { error: "任务指令不能为空" };

    const task: ScheduleTask = {
      id: randomUUID(),
      name: input.name?.trim() || input.prompt.trim().slice(0, 20),
      cron,
      kind,
      ...(kind === "at" && input.at ? { at: new Date(input.at).toISOString() } : {}),
      ...(kind === "every" && input.everyMs !== undefined ? { everyMs: Math.floor(input.everyMs) } : {}),
      ...(timezone ? { timezone } : {}),
      prompt: input.prompt.trim(),
      chatId: input.chatId,
      createdBy: input.createdBy,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    await this.store.put(task);
    if (this.started) this.scheduleJob(task);
    logger.info(`[Schedule] 新建定时任务 ${task.id}: ${task.name} (${cron})`);
    return { task };
  }

  /** 删除任务并撤下调度，返回回执文案。 */
  async removeTask(id: string): Promise<string> {
    this.unscheduleJob(id);
    const existed = await this.store.remove(id);
    return existed ? `已删除任务 ${id}` : `任务 ${id} 不存在`;
  }

  /** 启用/停用任务：停用只撤调度不删档案，可随时再启用。 */
  async setEnabled(id: string, enabled: boolean): Promise<string> {
    const task = await this.store.get(id);
    if (!task) return `任务 ${id} 不存在`;
    task.enabled = enabled;
    await this.store.put(task);
    if (enabled && this.started) this.scheduleJob(task);
    else this.unscheduleJob(id);
    return `${enabled ? "已启用" : "已停用"}任务 ${id}（${task.name}）`;
  }

  async listTasks(): Promise<ScheduleTask[]> {
    return this.store.list();
  }

  /** 立即触发一次（手动执行，不影响调度节奏）。
   *  执行在后台进行：一轮智能体可能跑数分钟，同步等待会卡住调用方（工具调用/指令）。 */
  async fireNow(id: string): Promise<string> {
    const task = await this.store.get(id);
    if (!task) return `任务 ${id} 不存在`;
    if (this.running.has(id)) return `任务 ${id} 正在执行，请等待本轮完成`;
    void this.execute(task).catch((error) => {
      logger.warn(`[Schedule] 手动触发执行失败 ${task.name}: ${error instanceof Error ? error.message : String(error)}`);
    });
    return `已触发任务 ${id}（${task.name}），后台执行中，结果会推送到会话`;
  }

  /** 校验一次性、固定间隔和 cron 三种调度形式。 */
  private validateSchedule(input: {
    kind: "cron" | "at" | "every";
    cron: string;
    at?: string;
    everyMs?: number;
    timezone?: string;
  }): string | undefined {
    if (input.kind === "at") {
      if (!input.at || Number.isNaN(Date.parse(input.at))) return "一次性任务需要合法的 ISO 8601 时间（如 2026-09-21T09:00:00+08:00）";
      if (Date.parse(input.at) <= Date.now()) return "一次性任务的时间必须晚于当前时间";
      return undefined;
    }
    if (input.kind === "every") {
      const everyMs = input.everyMs;
      if (typeof everyMs !== "number" || !Number.isFinite(everyMs) || !Number.isInteger(everyMs) || everyMs < 1_000) {
        return "固定间隔任务的 everyMs 必须是至少 1000 的整数（单位：毫秒）";
      }
      return undefined;
    }
    if (!input.cron || input.cron.split(/\s+/).length !== 5) {
      return `cron 表达式无效：${input.cron}（5 段：分 时 日 月 周，如 "0 9 * * *" = 每天 9 点）`;
    }
    try {
      new Cron(input.cron, { mode: "5-part", ...(input.timezone ? { timezone: input.timezone } : {}) }).stop();
      return undefined;
    } catch {
      return `cron 表达式无效：${input.cron}（请检查数值范围或时区 ${input.timezone ?? ""}）`;
    }
  }

  /** 上调度（已在跑的任务跳过；表达式失效只告警不影响其他任务）。 */
  private scheduleJob(task: ScheduleTask): void {
    if (this.jobs.has(task.id)) return;
    try {
      const fire = () => {
        void this.fire(task.id).catch((error) => logger.error(`[Schedule] 调度失败 ${task.id}:`, error));
      };
      const kind = task.kind ?? "cron";
      if (kind === "at") {
        const atMs = Date.parse(task.at ?? "");
        if (Number.isNaN(atMs)) throw new Error("一次性任务时间无效");
        const timer = setTimeout(fire, Math.max(0, atMs - Date.now()));
        this.jobs.set(task.id, { stop: () => clearTimeout(timer) });
      } else if (kind === "every") {
        const everyMs = task.everyMs;
        if (typeof everyMs !== "number" || !Number.isInteger(everyMs) || everyMs < 1_000) throw new Error("固定间隔无效");
        const timer = setInterval(fire, everyMs);
        this.jobs.set(task.id, { stop: () => clearInterval(timer) });
      } else {
        const job = new Cron(
          task.cron,
          { mode: "5-part", ...(task.timezone ? { timezone: task.timezone } : {}) },
          fire,
        );
        this.jobs.set(task.id, job);
      }
    } catch (error) {
      logger.warn(`[Schedule] 任务 ${task.id} cron 无效，跳过调度: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private unscheduleJob(id: string): void {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
  }

  /** cron 触发入口：重新读档案（任务可能已被删除/停用）。 */
  private async fire(id: string): Promise<void> {
    const task = await this.store.get(id);
    if (!task || !task.enabled) return;
    await this.execute(task);
  }

  /** 执行一次任务：跑智能体、推结果卡片、记录执行状态（成败都不抛出，不影响调度器）。 */
  private async execute(task: ScheduleTask): Promise<void> {
    if (this.running.has(task.id)) return;
    this.running.add(task.id);
    const startedAt = Date.now();
    logger.info(`[Schedule] 触发任务 ${task.id}（${task.name}）`);
    try {
      await this.runTask(task);
      await this.markResult(task, "ok");
      logger.info(`[Schedule] 任务 ${task.id} 执行完成（${Date.now() - startedAt}ms）`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.markResult(task, "error", detail);
      logger.warn(`[Schedule] 任务 ${task.id} 执行失败: ${detail}`);
    } finally {
      // 一次性任务只执行一次；保留档案便于查询结果，但不在重启后重复触发。
      if ((task.kind ?? "cron") === "at") {
        this.unscheduleJob(task.id);
        const current = await this.store.get(task.id);
        if (current) {
          current.enabled = false;
          await this.store.putIfPresent(current);
        }
      }
      this.running.delete(task.id);
    }
  }

  /** 回写最近一次执行结果（任务已被删除时静默跳过——putIfPresent 原子判定，
   *  防"后台执行写回"把刚删除的任务复活）。 */
  private async markResult(task: ScheduleTask, status: "ok" | "error", detail?: string): Promise<void> {
    const current = await this.store.get(task.id);
    if (!current) return;
    current.lastRunAt = Date.now();
    current.lastStatus = status;
    current.lastError = status === "error" ? detail : undefined;
    await this.store.putIfPresent(current);
  }
}
