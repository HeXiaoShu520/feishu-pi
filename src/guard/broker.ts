import { randomBytes, randomUUID } from "node:crypto";
import { buildPermissionCard, buildResultCard } from "./card.ts";
import { logger } from "../utils/logger.ts";

export interface BrokerOptions {
  ownerOpenId: string;
  timeoutMs: number;
  sendCard: (chatId: string, card: object) => Promise<string>;
  updateCard: (messageId: string, card: object) => Promise<void>;
  recallCard?: (messageId: string) => Promise<void>;
  shouldRecall?: (chatId: string) => boolean;
}

export interface ApprovalRequest {
  toolName: string;
  args: unknown;
  chatId: string;
  reason: string;
  requesterOpenId: string;
}

type ApprovalDecision = "allow_once" | "deny" | "timeout" | "cancelled";
interface PendingApproval {
  token: string;
  chatId: string;
  messageId?: string;
  decision?: ApprovalDecision;
  timer: NodeJS.Timeout;
  resolve: (allowed: boolean) => void;
  offAbort: () => void;
}

/** One owner, one-use confirmation. No roles, delegation or forwarded cards. */
export class PermissionBroker {
  private readonly options: BrokerOptions;
  private readonly pending = new Map<string, PendingApproval>();
  private closed = false;

  constructor(options: BrokerOptions) { this.options = options; }

  async requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<{ allowed: boolean; detail: string }> {
    if (signal?.aborted || this.closed) return { allowed: false, detail: "会话已中断或服务正在退出" };
    if (!this.options.ownerOpenId || request.requesterOpenId !== this.options.ownerOpenId) {
      return { allowed: false, detail: "个人助理只接受本人的授权请求" };
    }
    const approvalId = randomUUID();
    const token = randomBytes(16).toString("hex");
    const allowed = await new Promise<boolean>((resolve) => {
      const onAbort = () => this.finish(approvalId, "cancelled");
      const pending: PendingApproval = {
        token, chatId: request.chatId, resolve,
        timer: setTimeout(() => this.finish(approvalId, "timeout"), this.options.timeoutMs),
        offAbort: () => signal?.removeEventListener("abort", onAbort),
      };
      this.pending.set(approvalId, pending);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { this.finish(approvalId, "cancelled"); return; }
      const card = buildPermissionCard({ toolName: request.toolName, args: request.args, reason: request.reason, approvalId, token });
      void Promise.resolve().then(() => this.options.sendCard(request.chatId, card)).then((messageId) => {
        pending.messageId = messageId;
        // Sending can complete after timeout or cancellation; never leave a live-looking card behind.
        if (pending.decision) this.finalizeCard(pending);
      }).catch((error) => {
        logger.warn(`[Broker] 发送授权卡失败: ${error instanceof Error ? error.message : String(error)}`);
        this.finish(approvalId, "deny");
      });
    });
    return { allowed, detail: allowed ? "已授权一次" : "已拒绝、授权超时或会话已中断" };
  }

  async handleCallback(params: {
    approvalId?: string; token?: string; decision?: string;
    messageId: string; chatId: string; operatorOpenId: string;
  }): Promise<{ accepted: boolean; detail: string }> {
    const { approvalId, token, decision, messageId, chatId, operatorOpenId } = params;
    if (!approvalId || !token || (decision !== "allow_once" && decision !== "deny")) return { accepted: false, detail: "回调参数不合法" };
    const pending = this.pending.get(approvalId);
    if (!pending) return { accepted: false, detail: "该授权请求不存在或已处理" };
    if (pending.token !== token || pending.messageId !== messageId || pending.chatId !== chatId) return { accepted: false, detail: "token 或卡片来源不匹配" };
    if (operatorOpenId !== this.options.ownerOpenId) return { accepted: false, detail: "仅本人可操作" };
    this.finish(approvalId, decision);
    return { accepted: true, detail: decision === "allow_once" ? "已授权一次" : "已拒绝" };
  }

  close(): void { this.closed = true; for (const id of this.pending.keys()) this.finish(id, "cancelled"); }

  private finish(id: string, decision: ApprovalDecision): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.offAbort();
    pending.decision = decision;
    pending.resolve(decision === "allow_once");
    this.finalizeCard(pending);
  }

  private finalizeCard(pending: PendingApproval): void {
    if (!pending.messageId || !pending.decision) return;
    const operation = this.options.recallCard && this.options.shouldRecall?.(pending.chatId)
      ? this.options.recallCard(pending.messageId)
      : this.options.updateCard(pending.messageId, buildResultCard(pending.decision));
    void operation.catch((error) => logger.warn(`[Broker] 授权卡收尾失败: ${error instanceof Error ? error.message : String(error)}`));
  }
}
