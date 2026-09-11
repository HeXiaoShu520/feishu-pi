import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../utils/logger.ts";

/** 一个定时任务 */
export interface ScheduleTask {
  id: string;
  /** 任务名（展示用） */
  name: string;
  /** cron 表达式（5 段：分 时 日 月 周） */
  cron: string;
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
 * 定时任务持久化：JSON 文件（id → 任务），读写带串行队列与原子替换。
 */
export class ScheduleStore {
  private readonly filePath: string;
  private tasks = new Map<string, ScheduleTask>();
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async list(): Promise<ScheduleTask[]> {
    await this.ensureLoaded();
    return [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<ScheduleTask | undefined> {
    await this.ensureLoaded();
    return this.tasks.get(id);
  }

  async put(task: ScheduleTask): Promise<void> {
    await this.ensureLoaded();
    this.tasks.set(task.id, task);
    await this.flush();
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const existed = this.tasks.delete(id);
    if (existed) await this.flush();
    return existed;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as ScheduleTask[];
      this.tasks = new Map(raw.map((t) => [t.id, t]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(`[Schedule] 任务文件读取失败，按空处理: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.tasks = new Map();
    }
    this.loaded = true;
  }

  private async flush(): Promise<void> {
    const write = this.queue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, `${JSON.stringify([...this.tasks.values()], null, 2)}\n`, "utf8");
      const { rename } = await import("node:fs/promises");
      await rename(tmp, this.filePath);
    });
    this.queue = write.catch((error) => {
      logger.warn(`[Schedule] 任务文件写入失败: ${error instanceof Error ? error.message : String(error)}`);
    });
    await this.queue;
  }
}

export interface ScheduleServiceOptions {
  /** 任务持久化文件路径（data/schedules.json） */
  storeFile: string;
  /** 触发执行：运行智能体并把结果卡片推回目标会话（由 main 注入，复用会话链路与飞书传输） */
  runTask: (task: ScheduleTask) => Promise<void>;
}

/**
 * 定时任务服务：cron 调度（croner）+ 持久化 + 触发执行。
 * - 任务持久化在文件中，服务重启后自动恢复调度；
 * - 触发时执行注入的 runTask（跑智能体 → 推卡片），失败记录 lastStatus 并在下次 /cron list 可见；
 * - 同一任务触发时若上一轮未结束，由会话队列串行，不并发。
 */
export class ScheduleService {
  private readonly store: ScheduleStore;
  private readonly jobs = new Map<string, Cron>();
  private runTask?: (task: ScheduleTask) => Promise<void>;
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
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  /** 新建任务：校验 cron 表达式并持久化、上调度。返回 { task } 或 { error }。 */
  async addTask(input: { cron: string; prompt: string; chatId: string; createdBy: string; name?: string }): Promise<{ task?: ScheduleTask; error?: string }> {
    const cron = input.cron.trim();
    if (!this.isValidCron(cron)) return { error: `cron 表达式无效：${cron}（5 段：分 时 日 月 周，如 "0 9 * * *" = 每天 9 点）` };
    if (!input.prompt.trim()) return { error: "任务指令不能为空" };

    const task: ScheduleTask = {
      id: randomUUID().slice(0, 8),
      name: input.name?.trim() || input.prompt.trim().slice(0, 20),
      cron,
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

  async removeTask(id: string): Promise<string> {
    this.unscheduleJob(id);
    const existed = await this.store.remove(id);
    return existed ? `已删除任务 ${id}` : `任务 ${id} 不存在`;
  }

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

  /** 立即触发一次（手动执行，不影响调度节奏）。 */
  async fireNow(id: string): Promise<string> {
    const task = await this.store.get(id);
    if (!task) return `任务 ${id} 不存在`;
    await this.execute(task);
    return `已触发任务 ${id}（${task.name}），结果已推送到会话`;
  }

  /** 校验 cron 表达式。 */
  private isValidCron(expr: string): boolean {
    try {
      new Cron(expr, () => {}).stop();
      return true;
    } catch {
      return false;
    }
  }

  private scheduleJob(task: ScheduleTask): void {
    if (this.jobs.has(task.id)) return;
    try {
      const job = new Cron(task.cron, () => void this.fire(task.id));
      this.jobs.set(task.id, job);
    } catch (error) {
      logger.warn(`[Schedule] 任务 ${task.id} cron 无效，跳过调度: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private unscheduleJob(id: string): void {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
  }

  private async fire(id: string): Promise<void> {
    const task = await this.store.get(id);
    if (!task || !task.enabled) return;
    await this.execute(task);
  }

  /** 执行一次任务：跑智能体、推结果卡片、记录状态。 */
  private async execute(task: ScheduleTask): Promise<void> {
    const startedAt = Date.now();
    logger.info(`[Schedule] 触发任务 ${task.id}（${task.name}）`);
    try {
      if (!this.runTask) throw new Error("执行器未注入");
      await this.runTask(task);
      await this.markResult(task, "ok");
      logger.info(`[Schedule] 任务 ${task.id} 执行完成（${Date.now() - startedAt}ms）`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.markResult(task, "error", detail);
      logger.warn(`[Schedule] 任务 ${task.id} 执行失败: ${detail}`);
    }
  }

  private async markResult(task: ScheduleTask, status: "ok" | "error", detail?: string): Promise<void> {
    const current = await this.store.get(task.id);
    if (!current) return;
    current.lastRunAt = Date.now();
    current.lastStatus = status;
    current.lastError = status === "error" ? detail : undefined;
    await this.store.put(current);
  }
}

