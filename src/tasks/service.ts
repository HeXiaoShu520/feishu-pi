import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { open, mkdir, stat, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { JsonMapStore } from "../utils/json-store.ts";
import { stopProcess } from "../process/tree.ts";
import type { IdentityShellLease } from "../runtime/identity-bash.ts";
import { logger } from "../utils/logger.ts";

export type TaskStatus = "starting" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";
export interface BackgroundTask {
  id: string; name: string; command: string; cwd: string; chatId: string;
  status: TaskStatus; createdAt: string; finishedAt?: string; exitCode?: number | null;
  error?: string; logFile: string; logTruncated?: boolean; pid?: number; timeoutMs: number; notifiedAt?: string;
}
interface ActiveTask { child: ChildProcess; lease: IdentityShellLease; timer: NodeJS.Timeout; done: Promise<void>; stopReason?: "cancelled" | "timed_out" | "interrupted" }
export interface StartTask { name?: string; command: string; cwd: string; chatId: string; timeoutMs?: number }
export interface TaskServiceOptions {
  dataDir: string; maxConcurrent?: number; maxLogBytes?: number;
  notify?: (task: BackgroundTask) => Promise<void>;
}

/** Owns child processes and credential leases. Durable records survive restart; processes do not resume. */
export class BackgroundTaskService extends JsonMapStore<BackgroundTask> {
  private readonly options: TaskServiceOptions;
  private readonly active = new Map<string, ActiveTask>();
  private initializing?: Promise<void>;
  private closing = false;
  private starting = 0;
  constructor(options: TaskServiceOptions) { super(join(options.dataDir, "tasks", "tasks.json")); this.options = options; }

  initialize(): Promise<void> {
    this.initializing ??= (async () => {
      await this.ensureLoaded();
      let changed = false;
      for (const task of this.records.values()) if (task.status === "running" || task.status === "starting") {
        task.status = "interrupted"; task.error = "服务重启，原进程无法恢复；未自动重跑"; task.finishedAt = new Date().toISOString(); delete task.pid; changed = true;
      }
      if (changed) await this.persist();
    })().catch((error) => { this.initializing = undefined; throw error; });
    return this.initializing;
  }

  async start(input: StartTask, openLease: () => Promise<IdentityShellLease>, signal?: AbortSignal): Promise<BackgroundTask> {
    await this.initialize();
    signal?.throwIfAborted();
    if (this.closing) throw new Error("服务正在退出");
    if (this.active.size + this.starting >= (this.options.maxConcurrent ?? 3)) throw new Error("后台任务已达到并发上限");
    if (!input.command.trim()) throw new Error("command 不能为空");
    const timeoutMs = input.timeoutMs ?? 30 * 60_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 24 * 60 * 60_000) throw new Error("timeoutMs 范围为 1000～86400000");
    this.starting++;
    let lease: IdentityShellLease | undefined;
    try {
      const cwd = resolve(input.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error("工作目录不存在");
      const shell = getShellConfig();
      lease = await openLease();
      signal?.throwIfAborted();
      if (this.closing) throw new Error("服务正在退出");
      const id = randomUUID();
      const root = join(this.options.dataDir, "tasks", id);
      await mkdir(root, { recursive: true });
      const log = await open(join(root, "output.log"), "a");
      const task: BackgroundTask = { id, name: input.name?.trim() || "后台命令", command: input.command, cwd, chatId: input.chatId, timeoutMs, status: "starting", createdAt: new Date().toISOString(), logFile: join(root, "output.log") };
      this.records.set(id, task);
      try {
        await this.persist();
        signal?.throwIfAborted();
        if (this.closing) throw new Error("服务正在退出");
      } catch (error) {
        await log.close(); task.status = "interrupted"; task.finishedAt = new Date().toISOString();
        await this.persist().catch(() => undefined);
        throw error;
      }
      const command = `${lease.commandPrefix}\n${input.command}`;
      const child = spawn(shell.shell, [...shell.args, command], { cwd, env: lease.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      task.pid = child.pid;
      task.status = "running";
      const active: ActiveTask = { child, lease, timer: setTimeout(() => { void this.cancel(id, "timed_out").catch((error) => logger.error("[Tasks] 超时取消失败", error)); }, timeoutMs), done: Promise.resolve() };
      this.active.set(id, active);
      lease = undefined; // Ownership transfers to monitor(), including failures and cancellation.
      active.done = this.monitor(task, active, log);
      try { await this.persist(); }
      catch (error) { await this.cancel(id, "interrupted"); throw error; }
      return { ...task };
    } finally { this.starting--; await lease?.close(); }
  }

  async list(): Promise<BackgroundTask[]> { await this.initialize(); return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map((task) => ({ ...task })); }
  async get(id: string): Promise<BackgroundTask | undefined> { await this.initialize(); const task = this.records.get(id); return task && { ...task }; }

  async log(id: string, maxBytes = 16_000): Promise<{ task: BackgroundTask; text: string }> {
    const task = await this.get(id);
    if (!task) throw new Error("任务不存在");
    const file = await open(task.logFile, "r");
    try {
      const size = (await file.stat()).size;
      const length = Math.max(1, Math.min(maxBytes, 64_000));
      const buffer = Buffer.alloc(Math.min(size, length));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      return { task, text: `${size > length ? "[仅显示日志尾部]\n" : ""}${buffer.subarray(0, bytesRead).toString("utf8")}` };
    } finally { await file.close(); }
  }

  async cancel(id: string, reason: ActiveTask["stopReason"] = "cancelled"): Promise<BackgroundTask | undefined> {
    const active = this.active.get(id);
    if (active) { active.stopReason ??= reason; await stopProcess(active.child); await active.done; }
    return this.get(id);
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.active.keys()].map((id) => this.cancel(id, "interrupted")));
  }

  private async monitor(task: BackgroundTask, active: ActiveTask, log: FileHandle): Promise<void> {
    let written = 0, writes: Promise<unknown> = Promise.resolve(), writeError: unknown;
    const capture = (chunk: Buffer) => {
      const remaining = (this.options.maxLogBytes ?? 10 * 1024 * 1024) - written;
      if (remaining <= 0) { task.logTruncated = true; return; }
      const output = chunk.subarray(0, remaining); written += output.length;
      if (output.length < chunk.length) task.logTruncated = true;
      writes = writes.then(() => log.write(output)).catch((error) => { writeError = error; });
    };
    active.child.stdout!.on("data", capture); active.child.stderr!.on("data", capture);
    try {
      task.exitCode = await new Promise<number | null>((resolve, reject) => { active.child.once("error", reject); active.child.once("close", resolve); });
      await writes;
      if (writeError) throw writeError;
      task.status = active.stopReason ?? (task.exitCode === 0 ? "succeeded" : "failed");
    } catch (error) { task.status = active.stopReason ?? "failed"; task.error = error instanceof Error ? error.message : String(error); }
    finally {
      clearTimeout(active.timer);
      // A shell may exit with grandchildren still alive. This task owns and stops them as well.
      await stopProcess(active.child);
      await active.lease.close().catch((error) => logger.warn("[Tasks] 凭证代理回收失败", error));
      await log.close().catch(() => undefined);
      task.finishedAt = new Date().toISOString(); delete task.pid;
      this.active.delete(task.id);
      await this.persist().catch((error) => logger.error("[Tasks] 完成状态保存失败", error));
    }
    if (!this.closing && this.options.notify && task.chatId) {
      try { await this.options.notify({ ...task }); task.notifiedAt = new Date().toISOString(); await this.persist(); }
      catch (error) { logger.warn(`[Tasks] 完成通知发送失败: ${task.id}`, error); }
    }
  }
}
