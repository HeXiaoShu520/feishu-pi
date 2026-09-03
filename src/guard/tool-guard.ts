import type { CommandWhitelist } from "./whitelist.ts";
import type { SafetyJudge } from "./judge.ts";
import type { PermissionBroker } from "./broker.ts";
import type { UserRole } from "../runtime/types.ts";
import { logger } from "../utils/logger.ts";

export interface ToolGuardCheckParams {
  toolName: string;
  args: unknown;
  userRole: UserRole;
  chatId?: string;
}

/**
 * 工具调用 Guard 编排层，作为 Pi Agent 的 beforeToolCall 钩子：
 *   1. 管理员自己的会话：不审核（角色过滤已在上游完成）
 *   2. 指令白名单正则命中：自动放行
 *   3. 大模型 Guard 判定 allow：放行
 *   4. 判定 ask：发授权卡，等待管理员单次确认；拒绝/超时则拦截
 * 未配置 chatId 时无法发卡，一律拦截（默认拒绝）。
 */
export class ToolGuard {
  private readonly whitelist: CommandWhitelist;
  private readonly judge: SafetyJudge;
  private readonly broker: PermissionBroker;

  constructor(whitelist: CommandWhitelist, judge: SafetyJudge, broker: PermissionBroker) {
    this.whitelist = whitelist;
    this.judge = judge;
    this.broker = broker;
  }

  /** 审核一次工具调用，返回 block 信息；放行时返回 undefined。 */
  async check(params: ToolGuardCheckParams): Promise<{ block: true; reason: string } | undefined> {
    const { toolName, args, userRole } = params;
    if (userRole === "admin") return undefined;

    const hit = this.whitelist.match(toolName, args);
    if (hit) {
      logger.info(`[ToolGuard] 白名单命中 (${hit})，放行: ${toolName}`);
      return undefined;
    }

    const verdict = await this.judge.judge(toolName, args);
    if (verdict.decision === "allow") {
      logger.info(`[ToolGuard] Guard 放行 (${verdict.reason}): ${toolName}`);
      return undefined;
    }

    if (!params.chatId) {
      logger.warn(`[ToolGuard] 无会话 ID，无法发授权卡，按拒绝处理: ${toolName}`);
      return { block: true, reason: `工具 ${toolName} 需要管理员授权，但当前无法发起授权请求` };
    }

    logger.info(`[ToolGuard] Guard 要求授权 (${verdict.reason})，发送授权卡: ${toolName}`);
    const { allowed, detail } = await this.broker.requestApproval({ toolName, args, chatId: params.chatId, reason: verdict.reason });
    if (allowed) return undefined;
    return { block: true, reason: `工具 ${toolName} 未获得管理员授权：${detail}` };
  }
}
