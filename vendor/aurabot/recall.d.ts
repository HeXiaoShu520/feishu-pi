export interface RecallItem { id: string; text: string; importance: number; at: number; lastHit?: number; hitDays?: number; about?: string; invalidAt?: number }
export function tokenize(text: string): string[];
export function retention(memory: RecallItem, now?: number): number;
export function buildIndex(items: RecallItem[]): unknown;
export function search(index: unknown, query: string, options?: { about?: string | string[]; now?: number; limit?: number; minScore?: number }): Array<{ it: RecallItem; score: number; why: string[] }>;
