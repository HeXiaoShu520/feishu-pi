import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { FeishuContext } from "../context/types.ts";

export type UserRole = "default" | "team" | "admin";

export type FeishuPiEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_started"; toolName: string }
  | { type: "tool_updated"; toolName: string }
  | { type: "tool_finished"; toolName: string; isError: boolean };

export interface FeishuPiPrompt {
  text: string;
  images?: Array<{ data: Uint8Array; mimeType: string }>;
  context?: FeishuContext;
}

export interface FeishuPiConfig {
  cwd: string;
  sessionDir: string;
  modelProvider: string;
  modelName: string;
  modelBaseUrl?: string;
  builtinTools?: string[];
  systemPrompt?: string;
  adminId: string;
  teamMemberIdentifiers: string[];  // 团队成员标识（Open ID / 姓名 / 邮箱）
}

export interface FeishuPiSession {
  readonly sessionFile?: string;
  subscribe(listener: (event: FeishuPiEvent) => void): () => void;
  prompt(input: FeishuPiPrompt): Promise<void>;
  waitForIdle(): Promise<void>;
  abort(): void;
  getStats(): any;
  getModelName?(): string;
}

export type FeishuPiTool = AgentTool;
