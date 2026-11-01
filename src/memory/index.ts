import { createHash } from "node:crypto";
import { JsonMapStore } from "../utils/json-store.ts";

export interface MemoryDocument { id: string; source: string; kind: "memory" | "history"; text: string; timestamp?: string; role?: string; line: number }
export interface IndexedSource { signature: string; documents: MemoryDocument[] }
export interface MemoryQuery { query: string; kind?: "memory" | "history"; after?: string; before?: string; limit?: number }

/** Incremental lexical index: no embeddings, model calls, heartbeat or external database. */
export class MemoryIndex extends JsonMapStore<IndexedSource> {
  async sources(): Promise<Map<string, IndexedSource>> { await this.ensureLoaded(); return new Map(this.records); }
  async replace(sources: Map<string, IndexedSource>): Promise<void> { await this.ensureLoaded(); this.records = sources; await this.persist(); }
  async get(id: string): Promise<MemoryDocument | undefined> {
    await this.ensureLoaded();
    for (const source of this.records.values()) { const doc = source.documents.find((doc) => doc.id === id); if (doc) return doc; }
    return undefined;
  }
  async search(query: MemoryQuery) {
    await this.ensureLoaded();
    const normalized = normalize(query.query);
    if (!normalized) throw new Error("query 不能为空");
    const terms = [...new Set(normalized.split(/\s+/).filter(Boolean))].slice(0, 20);
    const after = dateBound(query.after, false), before = dateBound(query.before, true);
    const results: Array<MemoryDocument & { score: number }> = [];
    for (const source of this.records.values()) for (const doc of source.documents) {
      if (query.kind && doc.kind !== query.kind) continue;
      const time = doc.timestamp ? Date.parse(doc.timestamp) : NaN;
      if ((after !== undefined || before !== undefined) && (!Number.isFinite(time) || (after !== undefined && time < after) || (before !== undefined && time > before))) continue;
      const haystack = normalize(doc.text);
      const score = (haystack.includes(normalized) ? 5 : 0) + terms.filter((term) => haystack.includes(term)).length;
      if (score) results.push({ ...doc, score });
    }
    return results.sort((a, b) => b.score - a.score || (b.timestamp ?? "").localeCompare(a.timestamp ?? "")).slice(0, Math.max(1, Math.min(query.limit ?? 8, 30))).map((doc) => ({ ...doc, text: excerpt(doc.text, terms) }));
  }
}

export function documentId(source: string, line: number): string { return createHash("sha256").update(`${source}:${line}`).digest("hex").slice(0, 20); }
function normalize(text: string): string { return text.normalize("NFKC").toLowerCase().trim(); }
function excerpt(text: string, terms: string[]): string {
  const lower = normalize(text);
  const positions = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 150);
  return `${start ? "…" : ""}${text.slice(start, start + 1000)}${text.length > start + 1000 ? "…" : ""}`;
}
function dateBound(value: string | undefined, end: boolean): number | undefined {
  if (!value) return undefined;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) throw new Error(`无效日期: ${value}`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && end ? date + 86_400_000 - 1 : date;
}
