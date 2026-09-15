import { randomUUID, randomBytes } from "node:crypto";
import { buildPermissionCard, buildResultCard, buildNoticeCard } from "./card.ts";
import { logger } from "../utils/logger.ts";

export interface BrokerOptions {
  /** 管理员 Open ID 集合，点击回调时在服务端强制校验 */
  adminOpenIds: string[];
  /** 等待管理员点击的超时时间（超时视为拒绝） */
  timeoutMs: number;
  /** 向会话发送卡片，返回 messageId（用于后续更新为结果卡） */
  sendCard: (chatId: string, card: object) => Promise<string>;
  /** 向指定用户私聊发送卡片（receive_id_type=open_id，转发授权卡到管理员用） */
  sendCardToUser: (openId: string, card: object) => Promise<string>;
  /** 按 messageId 更新已发送的卡片 */
  updateCard: (messageId: string, card: object) => Promise<void>;
  /** 按 messageId 撤回消息（精简模式下授权确认后撤回卡片，减少占用） */
  recallCard?: (messageId: string) => Promise<void>;
  /** 是否在授权确认后撤回卡片（按发起授权的会话判断） */
  shouldRecall?: (chatId: string) => boolean;
}

export interface ApprovalRequest {
  toolName: string;
  args: unknown;
  chatId: string;
  reason: string;
}

export type ApprovalDecision = "allow_once" | "deny";

interface PendingApproval {
  token: string;
  chatId: string;
  toolName: string;
  toolArgs: unknown;
  messageId?: string;
  /** 转发到管理员私聊的卡片（messageId 在发送成功后回填） */
  forwarded?: { messageId?: string };
  timer: NodeJS.Timeout;
  resolve: (allowed: boolean) => void;
}

/**
 * 授权中枢：管理待授权请求，接收卡片回调并在服务端强制校验。
 * 校验项：approval 存在、token 一致、chat_id 一致、点击者是管理员、decision 合法、未处理过。
 * 任一不满足即拒绝，不唤醒工具调用。
 */
export class PermissionBroker {
  private readonly options: BrokerOptions;
  private readonly pending = new Map<string, PendingApproval>();

  constructor(options: BrokerOptions) {
    this.options = options;
  }

  /**
   * 授权结束（点击/超时/中断）后统一收尾所有已知卡片：
   * 精简模式（shouldRecall 为 true）撤回卡片，详细模式更新为结果卡。
   */
  private finalizeCards(pending: PendingApproval, decision: "allow_once" | "deny" | "timeout" | "cancelled"): void {
    const cardIds = [pending.messageId, pending.forwarded?.messageId].filter((id): id is string => Boolean(id));
    const recall = this.options.recallCard && this.options.shouldRecall?.(pending.chatId);
    for (const id of cardIds) {
      if (recall) {
        this.options.recallCard!(id).catch((error) =>
          logger.warn(`[Broker] 撤回授权卡失败: ${error instanceof Error ? error.message : error}`),
        );
      } else {
        this.options.updateCard(id, buildResultCard(decision)).catch((error) =>
          logger.warn(`[Broker] 更新结果卡失败: ${error instanceof Error ? error.message : error}`),
        );
      }
    }
  }

  /**
   * 发起一次授权：发送授权卡片并等待管理员决策；超时按拒绝处理。
   * signal 中止（如 /stop 中断会话）时立即取消等待、撤下卡片并释放队列。
   */
  async requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<{ allowed: boolean; detail: string }> {
    if (this.options.adminOpenIds.length === 0) {
      return { allowed: false, detail: "未配置管理员，无法授权" };
    }

    const approvalId = randomUUID();
    const token = randomBytes(16).toString("hex");

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(approvalId);
        if (!pending) return;
        this.pending.delete(approvalId);
        pending.resolve(false);
        this.finalizeCards(pending, "timeout");
      }, this.options.timeoutMs);

      this.pending.set(approvalId, { token, chatId: request.chatId, toolName: request.toolName, toolArgs: request.args, timer, resolve });

      // 会话中断（/stop）：立即取消等待，卡片收尾（精简模式撤回 / 详细模式更新为已取消）
      const onAbort = () => {
        const pending = this.pending.get(approvalId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(approvalId);
        pending.resolve(false);
        this.finalizeCards(pending, "cancelled");
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const card = buildPermissionCard({ toolName: request.toolName, args: request.args, approvalId, token });
      this.options
        .sendCard(request.chatId, card)
        .then((messageId) => {
          const pending = this.pending.get(approvalId);
          if (pending) pending.messageId = messageId;
        })
        .catch((error) => {
          // 卡片发送失败：直接拒绝并唤醒等待方
          logger.error(`[Broker] 发送授权卡失败: ${error instanceof Error ? error.message : error}`);
          const pending = this.pending.get(approvalId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(approvalId);
            pending.resolve(false);
          }
        });
    }).then((allowed) => ({
      allowed,
      detail: allowed ? "管理员已授权" : "管理员拒绝、授权超时或会话已中断",
    }));
  }

  /** 处理授权/拒绝回调。支持原会话卡片和转发到管理员私聊的卡片。 */
  async handleCallback(params: {
    approvalId?: string;
    token?: string;
    decision?: string;
    messageId: string;
    chatId: string;
    operatorOpenId: string;
  }): Promise<{ accepted: boolean; detail: string }> {
    const { approvalId, token, decision, messageId, chatId, operatorOpenId } = params;

    if (!approvalId || !token || (decision !== "allow_once" && decision !== "deny")) {
      return { accepted: false, detail: "回调参数不合法" };
    }
    const pending = this.pending.get(approvalId);
    if (!pending) return { accepted: false, detail: "该授权请求不存在或已处理" };

    // 服务端强制校验：token 一致，且消息必须是已登记的原卡或转发卡；决策者必须是管理员
    const isOriginal = messageId === pending.messageId && chatId === pending.chatId;
    const isForwarded = pending.forwarded?.messageId === messageId;
    if (pending.token !== token || (!isOriginal && !isForwarded)) {
      return { accepted: false, detail: "token 或卡片来源不匹配" };
    }
    if (!this.options.adminOpenIds.includes(operatorOpenId)) {
      return { accepted: false, detail: "仅管理员可操作" };
    }

    clearTimeout(pending.timer);
    this.pending.delete(approvalId);
    const allowed = decision === "allow_once";
    pending.resolve(allowed);

    // 决策后收尾所有已知卡片：精简模式撤回，详细模式更新为结果卡
    this.finalizeCards(pending, decision);
    return { accepted: true, detail: allowed ? "已授权一次" : "已拒绝" };
  }

  /** 处理「申请转发给管理员」回调：校验后把授权卡发到管理员私聊。 */
  async forwardToAdmin(params: { approvalId?: string; token?: string; messageId: string; chatId: string }): Promise<{ accepted: boolean; detail: string }> {
    const { approvalId, token, messageId, chatId } = params;
    if (!approvalId || !token) return { accepted: false, detail: "回调参数不合法" };

    const pending = this.pending.get(approvalId);
    if (!pending) return { accepted: false, detail: "该授权请求不存在或已处理" };
    if (pending.token !== token || messageId !== pending.messageId || chatId !== pending.chatId) {
      return { accepted: false, detail: "token 或卡片来源不匹配" };
    }
    if (pending.forwarded) return { accepted: false, detail: "该请求已转发过" };

    const target = this.options.adminOpenIds[0]!;
    const card = buildPermissionCard({ toolName: pending.toolName, args: pending.toolArgs, approvalId, token });
    try {
      // open_id 私聊投递（receive_id_type=open_id）——管理员的 open_id 不能当 chat_id 用
      const fwdMessageId = await this.options.sendCardToUser(target, card);
      pending.forwarded = { messageId: fwdMessageId };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error(`[Broker] 转发授权卡到管理员私聊失败: ${detail}`);
      return { accepted: false, detail: `转发失败：${detail}` };
    }

    // 原卡更新为提示，撤掉可点按钮
    if (pending.messageId) {
      await this.options
        .updateCard(pending.messageId, buildNoticeCard("📨 已转发给管理员私聊，等待授权……"))
        .catch((error) => logger.warn(`[Broker] 更新转发提示卡失败: ${error instanceof Error ? error.message : error}`));
    }
    return { accepted: true, detail: "已转发给管理员" };
  }
}
