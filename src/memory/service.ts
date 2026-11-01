import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, copyFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MemoryIndex, documentId, type MemoryDocument, type MemoryQuery, type IndexedSource } from "./index.ts";
import { SESSION_META_FILE } from "../utils/session-paths.ts";

export interface MemoryOptions { memoryDir: string; sessionsRoot?: string; ownerOpenId?: string }

/** Personal Markdown facts plus an on-demand index of the owner's user/assistant messages. */
export class MemoryService {
  private readonly options: MemoryOptions;
  private readonly index: MemoryIndex;
  private readonly file: string;
  private initializing?: Promise<void>;
  private syncing?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(options: MemoryOptions) {
    this.options = options;
    this.file = join(options.memoryDir, "MEMORY.md");
    this.index = new MemoryIndex(join(options.memoryDir, "index.json"));
  }

  async read(): Promise<string> {
    await this.initialize();
    await this.writes.catch(() => undefined);
    return readFile(this.file, "utf8");
  }

  async remember(text: string, rewrite = false): Promise<void> {
    if (!text.trim()) throw new Error("记忆内容不能为空");
    if (Buffer.byteLength(text, "utf8") > 256 * 1024) throw new Error("单次记忆写入超过 256 KiB");
    const operation = this.writes.catch(() => undefined).then(async () => {
      await this.initialize();
      if (rewrite) {
        const archive = join(this.options.memoryDir, "archive");
        await mkdir(archive, { recursive: true });
        await copyFile(this.file, join(archive, `${Date.now()}-${randomUUID()}.md`));
      }
      const previous = rewrite ? "" : await readFile(this.file, "utf8");
      const next = rewrite ? `${text.trim()}\n` : `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}- ${new Date().toISOString()} ${text.trim().replace(/\r?\n/g, " ")}\n`;
      const temporary = join(this.options.memoryDir, `.${randomUUID()}.tmp`);
      await writeFile(temporary, next, "utf8");
      await rename(temporary, this.file);
    });
    this.writes = operation;
    await operation;
  }

  async search(query: MemoryQuery, signal?: AbortSignal) {
    await this.refresh(signal);
    return this.index.search(query);
  }

  async get(id: string, signal?: AbortSignal): Promise<MemoryDocument | undefined> {
    await this.refresh(signal);
    const document = await this.index.get(id);
    if (!document) return undefined;
    if (document.kind === "memory") return document;
    let line = 0;
    for await (const source of lines(document.source, signal)) {
      if (++line !== document.line) continue;
      try {
        const entry = JSON.parse(source) as { message?: { content?: unknown } };
        return { ...document, text: messageText(entry.message?.content).slice(0, 12_000) };
      } catch { return undefined; }
    }
    return undefined;
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    if (this.syncing) { await this.syncing; signal?.throwIfAborted(); return; }
    this.syncing = this.synchronize(signal).finally(() => { this.syncing = undefined; });
    await this.syncing;
  }

  private initialize(): Promise<void> {
    this.initializing ??= (async () => {
      await mkdir(this.options.memoryDir, { recursive: true });
      try { await stat(this.file); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const owner = this.options.ownerOpenId;
      if (owner) {
        try { await copyFile(join(this.options.memoryDir, `${owner.replace(/[\\/:*?"<>|]/g, "_")}.md`), this.file); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      await writeFile(this.file, "", { flag: "wx" });
    })().catch((error) => { this.initializing = undefined; throw error; });
    return this.initializing;
  }

  private async synchronize(signal?: AbortSignal): Promise<void> {
    await this.initialize();
    await this.writes.catch(() => undefined);
    const sources: Array<{ path: string; kind: "memory" | "history" }> = await this.historyFiles(signal);
    sources.unshift({ path: this.file, kind: "memory" });
    const old = await this.index.sources();
    const next = new Map<string, IndexedSource>();
    let changed = false;
    for (const source of sources) {
      signal?.throwIfAborted();
      const info = await stat(source.path).catch(() => undefined);
      if (!info?.isFile()) continue;
      const signature = `${info.mtimeMs}:${info.size}`;
      const cached = old.get(source.path);
      if (cached?.signature === signature) { next.set(source.path, cached); continue; }
      const documents = await this.readDocuments(source.path, source.kind, signal);
      next.set(source.path, { signature, documents });
      changed = true;
    }
    if (changed || next.size !== old.size) await this.index.replace(next);
  }

  private async historyFiles(signal?: AbortSignal): Promise<Array<{ path: string; kind: "history" }>> {
    const root = this.options.sessionsRoot;
    if (!root) return [];
    const result: Array<{ path: string; kind: "history" }> = [];
    for (const dir of await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })) {
      signal?.throwIfAborted();
      if (!dir.isDirectory()) continue;
      const path = join(root, dir.name);
      const meta = await readFile(join(path, SESSION_META_FILE), "utf8").then((text) => JSON.parse(text) as { ownerOpenId?: string; conversationId?: string }).catch(() => undefined);
      if (!meta) continue;
      const owner = this.options.ownerOpenId;
      if (owner && meta.ownerOpenId !== owner && !meta.conversationId?.includes(owner)) continue;
      for (const file of await readdir(path, { withFileTypes: true }).catch(() => [])) {
        if (file.isFile() && file.name.endsWith(".jsonl")) result.push({ path: join(path, file.name), kind: "history" });
      }
    }
    return result;
  }

  private async readDocuments(path: string, kind: "memory" | "history", signal?: AbortSignal): Promise<MemoryDocument[]> {
    const documents: MemoryDocument[] = [];
    let line = 0;
    for await (const source of lines(path, signal)) {
      line++;
      let text = source, timestamp: string | undefined, role: string | undefined;
      if (kind === "history") {
        try {
          const entry = JSON.parse(source) as { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
          role = entry.message?.role;
          if (entry.type !== "message" || (role !== "user" && role !== "assistant")) continue;
          text = messageText(entry.message?.content);
          timestamp = entry.timestamp;
        } catch { continue; } // An in-flight final line can be incomplete; next refresh retries after mtime changes.
      } else timestamp = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/.exec(text)?.[0];
      if (!text.trim()) continue;
      for (let offset = 0; offset < text.length; offset += 1200) {
        documents.push({ id: `${documentId(path, line)}-${offset}`, source: path, kind, timestamp, role, line, text: text.slice(offset, offset + 1200) });
      }
    }
    return documents;
  }
}

async function* lines(path: string, signal?: AbortSignal) {
  const stream = createReadStream(path, { encoding: "utf8", signal });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of reader) { signal?.throwIfAborted(); yield line; } }
  finally { reader.close(); stream.destroy(); }
}
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}
