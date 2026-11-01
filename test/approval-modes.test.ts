import { describe, expect, it } from "vitest";
import { PermissionBroker } from "../src/guard/broker.ts";
import { buildPermissionCard } from "../src/guard/card.ts";

/** 构造注入版 broker：发起一次授权并回填卡片 messageId（记录发送的 messageId 供回调比对） */
function makeBroker() {
  const sentMessages: string[] = [];
  const broker = new PermissionBroker({
    ownerOpenId: "ou_requester",
    timeoutMs: 60_000,
    sendCard: async () => {
      const id = `om_card_${sentMessages.length + 1}`;
      sentMessages.push(id);
      return id;
    },
    updateCard: async () => {},
  });
  async function start(request: Parameters<PermissionBroker["requestApproval"]>[0]): Promise<{ approvalId: string; token: string; messageId: string }> {
    const task = broker.requestApproval(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pendingMap = (broker as unknown as { pending: Map<string, { token: string; messageId?: string }> }).pending;
    const approvalId = pendingMap.keys().next().value as string;
    const pending = pendingMap.get(approvalId)!;
    void task;
    return { approvalId, token: pending.token, messageId: pending.messageId ?? "" };
  }
  return { broker, start, sentMessages };
}

describe("个人助理确认卡", () => {
  it("本人可确认一次操作", async () => {
    const { broker, start } = makeBroker();
    const { approvalId, token, messageId } = await start({
      toolName: "bash", args: { command: "lark-cli calendar +agenda" }, chatId: "oc_chat",
      reason: "测试", requesterOpenId: "ou_requester",
    });
    const result = await broker.handleCallback({
      approvalId, token, decision: "allow_once",
      messageId, chatId: "oc_chat", operatorOpenId: "ou_requester",
    });
    expect(result.accepted).toBe(true);
  });

  it("其他身份点击被拒绝", async () => {
    const { broker, start } = makeBroker();
    const { approvalId, token, messageId } = await start({
      toolName: "bash", args: { command: "lark-cli im +send" }, chatId: "oc_chat",
      reason: "测试", requesterOpenId: "ou_requester",
    });
    const result = await broker.handleCallback({
      approvalId, token, decision: "allow_once",
      messageId, chatId: "oc_chat", operatorOpenId: "ou_admin",
    });
    expect(result.accepted).toBe(false);
    expect(result.detail).toContain("仅本人");
  });

  it("其他人的点击不消费请求，本人随后可确认", async () => {
    const { broker, start } = makeBroker();
    const { approvalId, token, messageId } = await start({
      toolName: "bash", args: { command: "npm run deploy" }, chatId: "oc_chat", reason: "测试", requesterOpenId: "ou_requester",
    });
    const deny = await broker.handleCallback({
      approvalId, token, decision: "allow_once",
      messageId, chatId: "oc_chat", operatorOpenId: "ou_random",
    });
    expect(deny.accepted).toBe(false);
    expect(deny.detail).toContain("仅本人");

    // 请求未被消费（拒绝的点击不计），本人随后可正常授权
    const allow = await broker.handleCallback({
      approvalId, token, decision: "allow_once",
      messageId, chatId: "oc_chat", operatorOpenId: "ou_requester",
    });
    expect(allow.accepted).toBe(true);
  });

  it("确认卡只保留本人允许和拒绝按钮", () => {
    const card = buildPermissionCard({ toolName: "bash", args: { command: "lark-cli okr list" }, approvalId: "a", token: "t", reason: "发布需要本人确认" });
    const text = JSON.stringify(card);
    expect(text).toContain("本人操作确认");
    expect(text).toContain("本次工具操作");
    expect(text).toContain("发布需要本人确认");
    expect(text).not.toContain("forward_approval");
    expect(text).not.toContain("管理员");
  });
});
