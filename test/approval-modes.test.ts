import { describe, expect, it } from "vitest";
import { PermissionBroker } from "../src/guard/broker.ts";
import { buildPermissionCard } from "../src/guard/card.ts";

/** 构造注入版 broker：发起一次授权并回填卡片 messageId（记录发送的 messageId 供回调比对） */
function makeBroker() {
  const sentMessages: string[] = [];
  const broker = new PermissionBroker({
    adminOpenIds: ["ou_admin"],
    timeoutMs: 60_000,
    sendCard: async () => {
      const id = `om_card_${sentMessages.length + 1}`;
      sentMessages.push(id);
      return id;
    },
    sendCardToUser: async () => `om_dm_${Date.now()}`,
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

describe("授权卡双模式（管理员卡 / 用户卡）", () => {
  it("用户卡（self）：发起者本人可批", async () => {
    const { broker, start } = makeBroker();
    const { approvalId, token, messageId } = await start({
      toolName: "bash", args: { command: "meegle mywork todo" }, chatId: "oc_chat",
      reason: "测试", mode: "self", requesterOpenId: "ou_requester",
    });
    const result = await broker.handleCallback({
      approvalId, token, decision: "allow_once",
      messageId, chatId: "oc_chat", operatorOpenId: "ou_requester",
    });
    expect(result.accepted).toBe(true);
  });

  it("用户卡：管理员（非发起者）点击被拒绝", async () => {
    const { broker, start } = makeBroker();
    const { approvalId, token, messageId } = await start({
      toolName: "bash", args: { command: "bbt pr list" }, chatId: "oc_chat",
      reason: "测试", mode: "self", requesterOpenId: "ou_requester",
    });
    const result = await broker.handleCallback({
      approvalId, token, decision: "allow_once",
      messageId, chatId: "oc_chat", operatorOpenId: "ou_admin",
    });
    expect(result.accepted).toBe(false);
    expect(result.detail).toContain("仅发起者本人");
  });

  it("管理员卡：非管理员点击被拒绝；管理员可批", async () => {
    const { broker, start } = makeBroker();
    const { approvalId, token, messageId } = await start({
      toolName: "bash", args: { command: "npm run deploy" }, chatId: "oc_chat", reason: "测试",
    });
    const deny = await broker.handleCallback({
      approvalId, token, decision: "allow_once",
      messageId, chatId: "oc_chat", operatorOpenId: "ou_random",
    });
    expect(deny.accepted).toBe(false);
    expect(deny.detail).toContain("仅管理员");

    // 请求未被消费（拒绝的点击不计），管理员随后可正常授权
    const allow = await broker.handleCallback({
      approvalId, token, decision: "allow_once",
      messageId, chatId: "oc_chat", operatorOpenId: "ou_admin",
    });
    expect(allow.accepted).toBe(true);
  });

  it("用户卡构建：无转发按钮，标题为用户身份确认；管理员卡含转发按钮", () => {
    const self = buildPermissionCard({ toolName: "bash", args: { command: "meegle todo" }, approvalId: "a", token: "t", mode: "self" });
    const selfStr = JSON.stringify(self);
    expect(selfStr).toContain("用户身份操作确认");
    expect(selfStr).toContain("你的个人凭证");
    expect(selfStr).not.toContain("转发管理员");

    const admin = buildPermissionCard({ toolName: "bash", args: {}, approvalId: "a", token: "t" });
    expect(JSON.stringify(admin)).toContain("转发管理员");
    expect(JSON.stringify(admin)).toContain("仅管理员点击有效");
  });
});
