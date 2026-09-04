/**
 * Runtime 层的类型定义：用户角色、Pi 会话事件、提示词、配置与会话接口。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { FeishuContext } from "../context/types.ts";

/** 用户角色：default 普通用户 / team 团队成员 / admin 管理员 */
export type UserRole = "default" | "team" | "admin";

/** Pi 会话事件（订阅转发给飞书卡片渲染） */
export type FeishuPiEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_started"; toolName: string; args?: unknown }
  | { type: "tool_updated"; toolName: string }
  | { type: "tool_finished"; toolName: string; isError: boolean };

/** 发给 Pi 会话的一条提示词 */
export interface FeishuPiPrompt {
  text: string;
  images?: Array<{ data: Uint8Array; mimeType: string }>;
  context?: FeishuContext;
}

/** Runtime 配置：工作目录、模型、权限与可选的 Guard 钩子 */
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
  /** 工具调用 Guard（beforeToolCall 钩子），可选；signal 中止（/stop）时取消授权等待 */
  toolGuard?: (params: { toolName: string; args: unknown; chatId?: string }, signal?: AbortSignal) => Promise<{ block: true; reason: string } | undefined>;
}

/** 对 Pi AgentSession 的最小接口封装（供会话管理与卡片渲染使用） */
export interface FeishuPiSession {
  readonly sessionFile?: string;
  subscribe(listener: (event: FeishuPiEvent) => void): () => void;
  prompt(input: FeishuPiPrompt): Promise<void>;
  waitForIdle(): Promise<void>;
  abort(): void;
  getStats(): any;
  getModelName?(): string;
  /** 当前上下文占用估算（含窗口与百分比），可选 */
  getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
}

export type FeishuPiTool = AgentTool;
