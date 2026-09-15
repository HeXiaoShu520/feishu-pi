import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "./logger.ts";

/**
 * JSON 字典文件的持久化基类：懒加载 + 串行写队列 + 临时文件原子替换。
 *
 * 子类持有 `records`（内存中的 string -> V 映射），通过 `ensureLoaded()` 读取、
 * `persist()` 原子写回。三个存储类（会话映射 / 消息状态 / 话题根）共用此框架。
 */
export abstract class JsonMapStore<V> {
  /** 内存中的记录；懒加载后可用 */
  protected records = new Map<string, V>();

  private loaded = false;
  private loadPromise?: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  /** 存储文件路径 */
  protected readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** 删除一条记录并落盘；返回删除前是否存在。 */
  protected async remove(key: string): Promise<boolean> {
    await this.ensureLoaded();
    const existed = this.records.delete(key);
    if (existed) await this.persist();
    return existed;
  }

  /** 仅当键仍存在时写入（存在性检查与写入之间无 await，防"删除-复活"竞态）。 */
  protected async writeIfPresent(key: string, record: V): Promise<boolean> {
    await this.ensureLoaded();
    if (!this.records.has(key)) return false;
    this.records.set(key, record);
    await this.persist();
    return true;
  }

  /** 懒加载文件内容；ENOENT（首次运行无文件）按空映射处理。加载 promise 会缓存，避免并发重复读。 */
  protected async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
        this.records = this.deserializeRecords(parsed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.loaded = true;
    })();
    await this.loadPromise;
  }

  /** 反序列化钩子：默认按"键 → 值"对象解析；子类可覆盖以兼容历史文件格式（如数组存储）。 */
  protected deserializeRecords(parsed: unknown): Map<string, V> {
    return new Map(Object.entries((parsed ?? {}) as Record<string, V>));
  }

  /** 串行原子写：先写临时文件再 rename 替换，避免写一半被读到。
   *  队列自身必须永远可继续：单次写入失败只抛给当次调用方，
   *  否则一个 rejected promise 会污染整条链，之后所有持久化静默失效。 */
  protected async persist(): Promise<void> {
    const task = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = join(dirname(this.filePath), `.${Date.now()}-${process.pid}.tmp`);
      await writeFile(temporaryPath, `${JSON.stringify(Object.fromEntries(this.records), null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    });
    this.writeQueue = task.catch((error) => {
      logger.error(`[JsonStore] 持久化失败（${this.filePath}）:`, error);
    });
    await task;
  }
}
