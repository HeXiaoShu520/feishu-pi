import type { ToolPolicy } from "../permission/policy.ts";
import { toolSelector } from "../permission/rules.ts";
import { mcpToolName } from "../mcp/names.ts";
import type { PermissionBroker } from "./broker.ts";
import type { PolicyJudge, PermissionOverview } from "./judge.ts";
import { logger } from "../utils/logger.ts";
import { isAbsolute, join, resolve, sep } from "node:path";
import { cliPolicyCommand, parseShellSteps, resolveSafeCd } from "../utils/shell-command.ts";

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

/** 单轮工具调用预算：超限后 block，拒绝理由回给模型引导其收尾输出最终答复。 */
export interface ToolCallLimiter {
  /** 每轮新消息开始时重置该会话的计数（由 bridge 调用）。 */
  reset(chatId: string): void;
  /** 记一次调用；超限返回拒绝理由（block），未超限返回 undefined。 */
  check(toolName: string, chatId?: string): string | undefined;
}

/**
 * 按 chatId 隔离计数的工具调用预算（默认上限由 FEISHU_ROUND_MAX_TOOL_CALLS 配置）。
 * 计数表只增不清：每个会话一条目，个人助理场景数量有限；reset 由每轮新消息触发。
 */
export function createToolCallLimiter(maxCalls: number): ToolCallLimiter {
  const counts = new Map<string, number>();
  return {
    reset: (chatId) => { counts.delete(chatId); },
    check: (toolName, chatId) => {
      const key = chatId || "__global__";
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count <= maxCalls) return undefined;
      logger.warn(`[ToolGuard] 本轮工具调用已达上限：${toolName} 是第 ${count} 次（上限 ${maxCalls}，会话 ${key}）`);
      return `本轮工具调用已达上限（${maxCalls} 次）。请停止调用工具，基于已有信息直接给出最终答复`;
    },
  };
}

/**
 * Personal gate: deny > high-risk confirmation > ask model > allow > default deny.
 * Adapters that execute other capabilities must authorize those capabilities too.
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

  async check(policy: ToolPolicy, params: ToolGuardCheckParams, signal?: AbortSignal): Promise<{ block: true; reason: string } | undefined> {
    if (signal?.aborted) return { block: true, reason: "会话已中断" };
    if (!policy.valid) return { block: true, reason: "权限配置不可用，默认拒绝工具调用" };

    const calls = projectedCalls(params);
    const candidates = ruleCalls(calls);
    const denyRule = candidates.map((call) => policy.denied(call.toolName, call.args)).find(Boolean);
    if (denyRule) return { block: true, reason: `权限策略直接拒绝：${denyRule}` };
    if (params.risky) return this.requireApproval(params, "该工具标记为高风险，需要本人确认", signal);
    const askRule = candidates.map((call) => policy.asked(call.toolName, call.args)).find(Boolean);
    if (!askRule) {
      if (calls.every((call) => this.isWhitelisted(policy, call))) return undefined;
      return { block: true, reason: `工具 ${params.toolName} 未命中 allow 或 ask，默认拒绝` };
    }
    const overview = this.getOverview ? await this.getOverview().catch(() => undefined) : undefined;
    const verdict = this.judge
      ? await this.judge.judge({ fields: policy.describe(), toolName: params.toolName, args: params.args, askRule, risky: false, overview }, signal)
      : { decision: "confirm" as const, reason: "审核模型未配置，需要本人确认" };
    if (signal?.aborted) return { block: true, reason: "会话已中断" };
    if (verdict.decision === "allow") return undefined;
    if (verdict.decision === "deny") return { block: true, reason: `审核模型拒绝：${verdict.reason}` };
    return this.requireApproval(params, verdict.reason, signal);
  }

  private isWhitelisted(policy: ToolPolicy, params: ToolGuardCheckParams): boolean {
    const { toolName, args } = params;
    if (toolName === "bash") {
      const command = extractCommand(args);
      if (command === undefined) return false;
      const allowed = (value: string): boolean => policy.bashAllowed(value) || policy.bashAllowed(cliPolicyCommand(value));
      const steps = parseShellSteps(command);
      if (steps && steps.length > 1) {
        let currentCwd = this.cwd;
        for (const step of steps) {
          if (/^cd\s+/i.test(step.command)) {
            const target = resolveSafeCd(step.command, currentCwd, this.cwd);
            if (!target) return false;
            currentCwd = target;
          } else if (!allowed(step.command)) {
            return false;
          }
        }
        return true;
      }
      return allowed(command) || allowCompositeCommand(command, this.cwd, allowed);
    }
    if (toolName === "read") {
      const path = extractPath(args);
      return path !== undefined && policy.readAllowed(path);
    }
    if (toolName === "write" || toolName === "edit") {
      const path = extractPath(args);
      return path !== undefined && policy.writeAllowed(path);
    }
    return policy.toolsAllowed(toolName) || policy.toolsAllowed(toolSelector(toolName, args));
  }

  private async requireApproval(
    params: ToolGuardCheckParams,
    reason: string,
    signal?: AbortSignal,
  ): Promise<{ block: true; reason: string } | undefined> {
    if (!params.chatId || !params.requesterOpenId) {
      logger.warn(`[ToolGuard] 无会话 ID，无法发授权卡，按拒绝处理: ${params.toolName}`);
      return { block: true, reason: `工具 ${params.toolName} 需要本人授权（${reason}），但当前缺少会话或本人身份` };
    }
    const { allowed, detail } = await this.broker.requestApproval({
      toolName: params.toolName,
      args: params.args,
      chatId: params.chatId,
      reason,
      requesterOpenId: params.requesterOpenId,
    }, signal);
    if (allowed) return undefined;
    return { block: true, reason: `工具 ${params.toolName} 未获得本人授权：${detail}` };
  }
}

/** Keep nested executors from bypassing Bash/Read/Write rules via a Tools grant. */
function projectedCalls(params: ToolGuardCheckParams): ToolGuardCheckParams[] {
  const calls = [params];
  const args = (params.args && typeof params.args === "object" ? params.args : {}) as Record<string, unknown>;
  if (params.toolName === "background_task" && args.action === "start" && typeof args.command === "string") {
    calls.push({ ...params, toolName: "bash", args: { command: args.command } });
  }
  if (params.toolName === "browser" && args.action === "upload" && typeof args.path === "string") {
    calls.push({ ...params, toolName: "read", args: { path: args.path } });
  }
  if (params.toolName === "mcp" && args.action === "call" && typeof args.server === "string" && typeof args.tool === "string") {
    calls.push({ ...params, toolName: mcpToolName(args.server, args.tool), args: args.args });
  }
  return calls;
}

function ruleCalls(calls: ToolGuardCheckParams[]): ToolGuardCheckParams[] {
  return calls.flatMap((call) => {
    const command = call.toolName === "bash" ? extractCommand(call.args) : undefined;
    if (!command) return [call];
    const steps = parseShellSteps(command)?.map((step) => step.command) ?? splitShellSegments(command);
    return [call, ...steps.flatMap((command) => [command, cliPolicyCommand(command)]).map((command) => ({ ...call, args: { command } }))];
  });
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
