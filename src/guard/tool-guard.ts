import type { GroupPolicy } from "../permission/policy.ts";
import { SHELL_META } from "../permission/policy.ts";
import type { PermissionBroker } from "./broker.ts";
import type { PolicyJudge, PermissionOverview } from "./judge.ts";
import { matchesUserIdentityCli } from "../runtime/identity-bash.ts";
import { logger } from "../utils/logger.ts";

export interface ToolGuardCheckParams {
  toolName: string;
  args: unknown;
  chatId?: string;
  /** 自定义工具标记 risk: "high" 时为 true：跳过策略放行，仍走授权卡 */
  risky?: boolean;
  /** 发起者 openId：bash 命中用户身份 CLI 时弹"用户卡"，仅本人可批 */
  requesterOpenId?: string;
}

/**
 * 工具调用 Guard，作为 Pi Agent 的 beforeToolCall 钩子。
 * 判定流程（deny 规则 → 策略 → 智能体 → 授权卡）：
 *
 *   ⓪ deny 规则（.env、密钥/凭据等路径 glob，permissions.json "deny" 可扩展）：
 *      bash 命令 token / write·edit 路径命中 → 一律拦截，对所有人（含管理员）生效；
 *      read 路径在 runtime 分支用同一份 deny 清单先行拦截
 *   ① 调用命中所属组策略（bash 名单 / write 范围 / tools 名单）→ 免审放行
 *   ② 策略未命中 → 智能体综合判断（以该组授权策略为参考）：
 *        allow → 放行；ask → 授权卡
 *      （覆盖复合命令等规则永远命中不了的调用；未配置智能体时直接授权卡）
 *   ③ 智能体 ask → 授权卡，按身份分流：
 *        bash 使用发起者的用户身份 CLI 凭证（lark-cli 用户态）→ 用户卡，本人单次确认；
 *        其余 → 管理员卡，负责人单次确认；拒绝/超时/无会话发卡 → 拦截
 *
 * read 的可读范围判定在 runtime 的 read 分支先行处理，不会到这里。
 * 所有身份（含负责人）都过此闸。
 */
export class ToolGuard {
  private readonly broker: PermissionBroker;
  private readonly judge?: PolicyJudge;
  /** 全量权限配置提供器（供智能体审核时把整份 permission 交给审核模型） */
  private readonly getOverview?: () => Promise<PermissionOverview | undefined>;

  constructor(
    broker: PermissionBroker,
    judge?: PolicyJudge,
    getOverview?: () => Promise<PermissionOverview | undefined>,
  ) {
    this.broker = broker;
    this.judge = judge;
    this.getOverview = getOverview;
  }

  async check(policy: GroupPolicy, params: ToolGuardCheckParams, signal?: AbortSignal): Promise<{ block: true; reason: string } | undefined> {
    const { toolName, args, risky } = params;

    // ⓪ deny 规则（第 0 层）：先于组策略、智能体审核与授权卡，对所有人（含管理员）生效。
    // bash 按命令 token 匹配；read 在 runtime 分支先行拦截；这里补 write/edit 的路径拦截。
    if (toolName === "bash") {
      const command = extractCommand(args);
      const denyHit = command !== undefined
        ? command.split(/[\s'"`;&|()<>,]+/).map((token) => (token ? policy.deniedPath(token) : undefined)).find(Boolean)
        : undefined;
      if (denyHit) {
        logger.warn(`[ToolGuard] bash 命令引用禁止路径，已拦截: ${command}（命中 ${denyHit}）`);
        return {
          block: true,
          reason: `⛔ 命令引用了受保护的路径（命中 deny 规则 ${denyHit}），不允许通过指令访问；如需其中信息，请让用户自行查看后告知`,
        };
      }
    } else if (toolName === "write" || toolName === "edit") {
      const path = extractPath(args);
      const denyHit = path !== undefined ? policy.deniedPath(path) : undefined;
      if (denyHit) {
        logger.warn(`[ToolGuard] 写入禁止路径，已拦截: ${path}（命中 ${denyHit}）`);
        return { block: true, reason: `⛔ 该路径已被权限策略禁止读写（命中 deny 规则 ${denyHit}）` };
      }
    }

    // ① 组策略命中 → 免审放行（确定性判定）；未命中的日志由 Judge 单行记录（命令+结论），此处不再重复
    if (toolName === "bash") {
      const command = extractCommand(args);
      if (command !== undefined && policy.bashAllowed(command)) {
        logger.info(`[ToolGuard] bash 命中策略名单，放行: ${command}`);
        return undefined;
      }
    } else if (toolName === "write" || toolName === "edit") {
      const path = extractPath(args);
      if (path !== undefined && policy.writeAllowed(path)) {
        logger.info(`[ToolGuard] 写入命中策略范围，放行: ${path}`);
        return undefined;
      }
    } else if (!risky) {
      // 自定义工具（非内置 bash/write/edit）：toolsAllowed 已在之前验证通过，免审放行；标记 risky 的走授权卡
      logger.info(`[ToolGuard] 自定义工具放行: ${toolName}`);
      return undefined;
    }

    // ② 策略未命中 → 智能体综合判断（把整份权限配置交给审核模型参考）
    if (this.judge?.enabled) {
      const fields = policy.describe();
      const overview = this.getOverview ? await this.getOverview().catch(() => undefined) : undefined;
      const verdict = await this.judge.judge({ group: policy.groups.join(","), fields, toolName, args, overview });
      if (verdict.decision === "allow") {
        logger.info(`[ToolGuard] 策略外调用，智能体综合判断放行: ${toolName}（${verdict.reason}）`);
        return undefined;
      }
      logger.info(`[ToolGuard] 策略外调用，智能体判断需确认: ${toolName}（${verdict.reason}）`);
      return this.requireApproval(params, verdict.reason, signal);
    }

    // ③ 智能体未配置 → 名单外调用直接授权卡
    return this.requireApproval(params, this.defaultReason(policy, toolName, args), signal);
  }

  /** 未启用智能体时的兜底理由。 */
  private defaultReason(policy: GroupPolicy, toolName: string, args?: unknown): string {
    if (toolName === "bash") {
      const command = extractCommand(args);
      if (command !== undefined && SHELL_META.test(command)) return "命令含拼接符（; | && $( 换行等），为防逃逸需人工确认";
      return "命令不在 bash 允许名单内";
    }
    if (toolName === "write" || toolName === "edit") return "写入路径不在允许范围内";
    return `工具 ${toolName} 不在你的可用清单内`;
  }

  /** 走授权卡流程；无会话无法发卡时按拒绝处理。
   *  分流：bash 命令使用发起者的用户身份 CLI 凭证（lark-cli 用户态）→
   *  弹"用户卡"由本人确认（无需管理员）；其余弹管理员卡。 */
  private async requireApproval(
    params: ToolGuardCheckParams,
    reason: string,
    signal?: AbortSignal,
  ): Promise<{ block: true; reason: string } | undefined> {
    if (!params.chatId) {
      logger.warn(`[ToolGuard] 无会话 ID，无法发授权卡，按拒绝处理: ${params.toolName}`);
      return { block: true, reason: `工具 ${params.toolName} 需要授权（${reason}），但当前无法发起授权请求` };
    }

    const command = params.toolName === "bash" ? extractCommand(params.args) : undefined;
    const selfApprove = command !== undefined && matchesUserIdentityCli(command);
    const mode = selfApprove ? "self" : "admin";
    logger.info(`[ToolGuard] 需要授权 (${reason})，发送${selfApprove ? "用户卡" : "管理员卡"}: ${params.toolName}`);
    const { allowed, detail } = await this.broker.requestApproval(
      {
        toolName: params.toolName,
        args: params.args,
        chatId: params.chatId,
        reason,
        mode,
        requesterOpenId: selfApprove ? params.requesterOpenId : undefined,
      },
      signal,
    );
    if (allowed) return undefined;
    const approver = selfApprove ? "发起者本人" : "负责人";
    return { block: true, reason: `工具 ${params.toolName} 未获得${approver}授权：${detail}` };
  }
}

/** 从工具参数中提取路径（read/write/edit: path/file_path）。 */
function extractPath(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file_path"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return undefined;
}

/** 从 bash 参数中提取命令。 */
function extractCommand(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

/** 日志用单行化：压平换行并截断，避免多行命令刷屏。 */
function singleLine(text: string, maxLength: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}
