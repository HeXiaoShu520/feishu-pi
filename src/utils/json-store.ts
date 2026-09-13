import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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

  /** 串行原子写：先写临时文件再 rename 替换，避免写一半被读到。 */
  protected async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = join(dirname(this.filePath), `.${Date.now()}-${process.pid}.tmp`);
      await writeFile(temporaryPath, `${JSON.stringify(Object.fromEntries(this.records), null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    });
    await this.writeQueue;
  }
}
