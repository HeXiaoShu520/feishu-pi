import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { FeishuContext } from "../context/types.ts";

export interface FeishuPiEvent {
  type: "assistant_text";
  text: string;
}

export interface FeishuPiPrompt {
  text: string;
  images?: Array<{ data: Uint8Array; mimeType: string }>;
  context?: FeishuContext;
}

export interface FeishuPiConfig {
  cwd: string;
  sessionDir: string;
  modelProvider: string;
  modelId: string;
  modelBaseUrl?: string;
  builtinTools?: string[];
}

export interface FeishuPiSession {
  readonly sessionFile?: string;
  subscribe(listener: (event: FeishuPiEvent) => void): () => void;
  prompt(input: FeishuPiPrompt): Promise<void>;
  waitForIdle(): Promise<void>;
}

export type FeishuPiTool = AgentTool;
