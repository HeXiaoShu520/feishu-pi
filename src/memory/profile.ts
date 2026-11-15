import type { MemoryEntry } from "./service.ts";

export const PROFILE_SECTIONS = { preference: "偏好", boundary: "相处边界", fact: "自述背景", episode: "共同话题与经历" } as const;

/** A view, not another model-written summary. Keeps provenance and uncertainty. */
export function buildUserProfile(entries: MemoryEntry[]) {
  return { version: 1, source: "当前用户有原话依据的资料", sections:
    Object.entries(PROFILE_SECTIONS).map(([kind, label]) => ({ kind, label,
      items: entries.filter(e => e.subject !== "self" && e.kind === kind).map(e => ({
        id: e.id, topic: e.topic, summary: e.summary, evidence: e.evidence,
        status: "从本人发言整理，未经独立核实",
        updatedAt: e.updatedAt,
      })),
    })) };
}
