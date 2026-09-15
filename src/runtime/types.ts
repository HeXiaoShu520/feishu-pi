/**
 * Runtime 层的类型定义：Pi 会话事件、提示词、配置与会话接口。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SkillUsageStore } from "../stats/skill-usage-store.ts";
import type { GroupPolicy, PermissionPolicy } from "../permission/policy.ts";
import type { ScheduleService } from "../schedule/service.ts";
import type { FeishuContext } from "../context/types.ts";

/** Pi 会话事件（订阅转发给飞书卡片渲染） */
export type FeishuPiEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_started"; toolName: string; args?: unknown }
  | { type: "tool_updated"; toolName: string }
  | { type: "tool_finished"; toolName: string; isError: boolean };

/** 发给 Pi 会话的一条提示词（调用者身份经 ConversationMessage.context 单独传递） */
export interface FeishuPiPrompt {
  text: string;
  images?: Array<{ data: Uint8Array; mimeType: string }>;
}

/** Pi 会话统计的最小结构：卡片统计小字（token/费用/会话别名）只消费这些字段 */
export interface SessionStats {
  tokens?: { total?: number | null };
  cost?: number;
  sessionId?: string;
}

/** Runtime 配置：工作目录、模型、权限与可选的 Guard 钩子 */
export interface FeishuPiConfig {
  cwd: string;
  sessionDir: string;
  modelProvider: string;
  modelName: string;
  modelBaseUrl?: string;
  systemPrompt?: string;
  /** 管理员 Open ID；其余所有人均为 user 组 */
  adminId: string;
  /** 统一权限策略（.agent/permissions.json）：工具注册、调用判定、可读范围全部由它驱动 */
  permissionPolicy: PermissionPolicy;
  /** 工具调用 Guard（beforeToolCall 钩子），可选；signal 中止（/stop）时取消授权等待。
   *  risky = 自定义工具标记了 risk: "high"，需要走授权卡。 */
  toolGuard?: (policy: GroupPolicy, params: { toolName: string; args: unknown; chatId?: string; risky?: boolean }, signal?: AbortSignal) => Promise<{ block: true; reason: string } | undefined>;
  /** 技能使用统计存储（可选）；提供时在 beforeToolCall 记录技能文件读取事件，并注入查询工具 */
  skillUsageStore?: SkillUsageStore;
  /** 定时任务服务（可选）；提供时为负责人会话注入定时任务管理工具 */
  scheduleService?: ScheduleService;
  /**
   * 会话级"带身份"bash 工厂（可选）；提供时以同名自定义工具覆盖内置 bash，
   * 在每次命令 spawn 前按会话用户注入 CLI 凭证环境变量（lark-cli 等，见 identity-bash.ts）。
   * 参数为该会话的用户 openId 与会话上下文（chatId 用于缺权限时把授权卡发到当前会话）。
   */
  identityBash?: (userId: string, context?: FeishuContext) => ToolDefinition;
}

/** 对 Pi AgentSession 的最小接口封装（供会话管理与卡片渲染使用） */
export interface FeishuPiSession {
  readonly sessionFile?: string;
  subscribe(listener: (event: FeishuPiEvent) => void): () => void;
  prompt(input: FeishuPiPrompt): Promise<void>;
  waitForIdle(): Promise<void>;
  abort(): void;
  getStats(): SessionStats;
  getModelName?(): string;
  /** 当前上下文占用估算（含窗口与百分比），可选 */
  getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
}

/** 项目工具类型：Pi AgentTool + 可选高危标记（risk: "high" 时跳过策略放行走授权卡） */
export type FeishuPiTool = AgentTool & { risk?: "high" };
