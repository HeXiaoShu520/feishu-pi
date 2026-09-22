import type { GroupPolicy } from "../permission/policy.ts";
import type { PermissionBroker } from "./broker.ts";
import type { PolicyJudge, PermissionOverview } from "./judge.ts";
import { logger } from "../utils/logger.ts";
import { isAbsolute, join, resolve, sep } from "node:path";

export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const ch of command) {
    if (quote) { current += ch; if (ch === quote) quote = undefined; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === "&" || ch === "|" || ch === ";" || ch === "\n" || ch === "\r") { segments.push(current); current = ""; continue; }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

const COMPOSITE_VETO = /[`$<>\\()]/;

export function allowCompositeCommand(command: string, cwd: string, segmentAllowed: (segment: string) => boolean): boolean {
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  const normalizedCwd = resolve(cwd);
  for (const segment of segments) {
    if (COMPOSITE_VETO.test(segment)) return false;
    const cdMatch = segment.match(/^cd\s+(.*)$/);
    if (cdMatch) {
      const raw = cdMatch[1].trim().replace(/^["']|["']$/g, "");
      if (!raw || raw === "-" || raw === "..") return false;
      const target = resolve(cwd, isAbsolute(raw) ? raw : join(cwd, raw));
      if (target !== normalizedCwd && !target.startsWith(normalizedCwd + sep)) return false;
      continue;
    }
    if (!segmentAllowed(segment)) return false;
  }
  return true;
}

export interface ToolGuardCheckParams {
  toolName: string;
  args: unknown;
  chatId?: string;
  risky?: boolean;
  requesterOpenId?: string;
}

/**
 * 统一门禁：deny 阻止白名单直通 → 白名单直接通过 → LLM 决定直接通过、管理员卡或用户卡。
 * read 和自定义工具也走同一条路径，避免各层各自做“名单外拒绝”。
 */
export class ToolGuard {
  private readonly broker: PermissionBroker;
  private readonly judge?: PolicyJudge;
  private readonly getOverview?: () => Promise<PermissionOverview | undefined>;
  private readonly cwd: string;

  constructor(broker: PermissionBroker, judge?: PolicyJudge, getOverview?: () => Promise<PermissionOverview | undefined>, cwd?: string) {
    this.broker = broker;
    this.judge = judge;
    this.getOverview = getOverview;
    this.cwd = cwd ?? process.cwd();
  }

  async check(policy: GroupPolicy, params: ToolGuardCheckParams, signal?: AbortSignal): Promise<{ block: true; reason: string } | undefined> {
    if (signal?.aborted) return { block: true, reason: "会话已中断" };

    const denyRule = policy.denied(params.toolName, params.args);
    // deny 命中不能被白名单直接放行，但不是永久拒绝：仍交 LLM 给出上下文与理由，
    // 最终固定走管理员单次授权，形成可审计的显式例外。
    if (!denyRule && this.isWhitelisted(policy, params)) return undefined;

    const fields = policy.describe();
    const overview = this.getOverview ? await this.getOverview().catch(() => undefined) : undefined;
    const verdict = this.judge
      ? await this.judge.judge({ groups: policy.groups, isAdmin: policy.isAdmin, fields, toolName: params.toolName, args: params.args, denyRule, risky: Boolean(params.risky), overview })
      : { decision: "admin" as const, reason: "智能门禁未装配，需管理员确认" };
    if (!denyRule && verdict.decision === "allow") return undefined;
    // 用户卡必须绑定真实的请求者；上下文缺失时宁可提升为管理员卡，不能产生无人可批准的卡片。
    const mode = denyRule || verdict.decision !== "user" || !params.requesterOpenId ? "admin" : "self";
    return this.requireApproval(params, verdict.reason, mode, signal);
  }

  private isWhitelisted(policy: GroupPolicy, params: ToolGuardCheckParams): boolean {
    const { toolName, args } = params;
    if (toolName === "ask_user_question") return true;
    if (toolName === "bash") {
      const command = extractCommand(args);
      return command !== undefined && (policy.bashAllowed(command) || allowCompositeCommand(command, this.cwd, (segment) => policy.bashAllowed(segment)));
    }
    if (toolName === "read") {
      const path = extractPath(args);
      return path !== undefined && policy.readAllowed(path);
    }
    if (toolName === "write" || toolName === "edit") {
      const path = extractPath(args);
      return path !== undefined && policy.writeAllowed(path);
    }
    return policy.toolsAllowed(toolName);
  }

  private async requireApproval(
    params: ToolGuardCheckParams,
    reason: string,
    mode: "admin" | "self",
    signal?: AbortSignal,
  ): Promise<{ block: true; reason: string } | undefined> {
    if (!params.chatId) {
      logger.warn(`[ToolGuard] 无会话 ID，无法发授权卡，按拒绝处理: ${params.toolName}`);
      return { block: true, reason: `工具 ${params.toolName} 需要${mode === "self" ? "本人" : "管理员"}授权（${reason}），但当前无法发起授权请求` };
    }
    const { allowed, detail } = await this.broker.requestApproval({
      toolName: params.toolName,
      args: params.args,
      chatId: params.chatId,
      reason,
      mode,
      requesterOpenId: mode === "self" ? params.requesterOpenId : undefined,
    }, signal);
    if (allowed) return undefined;
    const approver = mode === "self" ? "发起者本人" : "管理员";
    return { block: true, reason: `工具 ${params.toolName} 未获得${approver}授权：${detail}` };
  }
}

function extractPath(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file_path"]) if (typeof record[key] === "string" && record[key]) return record[key] as string;
  return undefined;
}

function extractCommand(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}
