import { describe, expect, it } from "vitest";
import { PermissionBroker } from "../src/guard/broker.ts";
import { buildNoticeCard } from "../src/guard/card.ts";

/** 构造注入版 broker：发起一次真实授权并回填卡片 messageId，供转发链路测试 */
function makeBroker(opts: {
  sendCardToUser?: (openId: string, card: object) => Promise<string>;
  updateCard?: (messageId: string, card: object) => Promise<void>;
} = {}) {
  const sentToChats: string[] = [];
  const sentToUsers: string[] = [];
  const updatedCards: Array<{ messageId: string; card: object }> = [];
  const broker = new PermissionBroker({
    adminOpenIds: ["ou_admin"],
    timeoutMs: 60_000,
    sendCard: async (chatId) => {
      sentToChats.push(chatId);
      return `om_orig-${sentToChats.length}`;
    },
    sendCardToUser: opts.sendCardToUser ?? (async (openId) => {
      sentToUsers.push(openId);
      return `om_fwd-${sentToUsers.length}`;
    }),
    updateCard: opts.updateCard ?? (async (messageId, card) => {
      updatedCards.push({ messageId, card });
    }),
  });

  async function startApproval(chatId = "oc_group"): Promise<{ approvalId: string; token: string }> {
    const task = broker.requestApproval({ toolName: "bash", args: { command: "git push" }, chatId, reason: "测试" });
    // 等卡片发出（requestApproval 内部异步回填 messageId）
    await new Promise((resolve) => setTimeout(resolve, 0));
    const approvalId = (broker as unknown as { pending: Map<string, { token: string }> }).pending.keys().next().value as string;
    const token = (broker as unknown as { pending: Map<string, { token: string }> }).pending.get(approvalId)!.token;
    void task;
    return { approvalId, token };
  }
  return { broker, startApproval, sentToChats, sentToUsers, updatedCards };
}

describe("PermissionBroker.forwardToAdmin（转发授权到管理员私聊）", () => {
  it("转发走 sendCardToUser（open_id 通道），原卡更新为转发提示", async () => {
    const { broker, startApproval, sentToUsers, updatedCards } = makeBroker();
    const { approvalId, token } = await startApproval();

    const result = await broker.forwardToAdmin({ approvalId, token, messageId: "om_orig-1", chatId: "oc_group" });
    expect(result.accepted).toBe(true);
    // 关键回归：管理员的 open_id 必须经 open_id 通道投递，而不是被当 chat_id 发送
    expect(sentToUsers).toEqual(["ou_admin"]);
    // 原卡更新为提示
    expect(updatedCards).toHaveLength(1);
    expect(JSON.stringify(updatedCards[0].card)).toContain("已转发给管理员私聊");
  });

  it("转发后的私聊卡可由管理员完成授权（isForwarded 通道）", async () => {
    const { broker, startApproval } = makeBroker();
    const { approvalId, token } = await startApproval();
    await broker.forwardToAdmin({ approvalId, token, messageId: "om_orig-1", chatId: "oc_group" });

    const task = broker.handleCallback({
      approvalId,
      token,
      decision: "allow_once",
      messageId: "om_fwd-1",
      chatId: "oc_admin_p2p",
      operatorOpenId: "ou_admin",
    });
    // handleCallback 内部会 resolve 等待中的 requestApproval
    const result = await task;
    expect(result.accepted).toBe(true);
  });

  it("私聊投递失败 → 不标记已转发、给出真实失败原因", async () => {
    const updatedCards: Array<{ messageId: string; card: object }> = [];
    const { broker, startApproval } = makeBroker({
      sendCardToUser: async () => {
        throw new Error("open_id 无效");
      },
      updateCard: async (messageId, card) => {
        updatedCards.push({ messageId, card });
      },
    });
    const { approvalId, token } = await startApproval();

    const result = await broker.forwardToAdmin({ approvalId, token, messageId: "om_orig-1", chatId: "oc_group" });
    expect(result.accepted).toBe(false);
    expect(result.detail).toContain("转发失败");
    expect(result.detail).toContain("open_id 无效");
    // 失败时不更新原卡为"已转发"（错误提示由 main 层决定）
    expect(updatedCards).toHaveLength(0);

    // 失败后请求仍有效：管理员仍可在原卡授权
    const decision = await broker.handleCallback({
      approvalId, token, decision: "allow_once",
      messageId: "om_orig-1", chatId: "oc_group", operatorOpenId: "ou_admin",
    });
    expect(decision.accepted).toBe(true);
  });

  it("重复转发被拒绝；参数不合法被拒绝", async () => {
    const { broker, startApproval } = makeBroker();
    const { approvalId, token } = await startApproval();

    expect((await broker.forwardToAdmin({ approvalId, token, messageId: "om_orig-1", chatId: "oc_group" })).accepted).toBe(true);
    const second = await broker.forwardToAdmin({ approvalId, token, messageId: "om_orig-1", chatId: "oc_group" });
    expect(second.accepted).toBe(false);
    expect(second.detail).toContain("已转发过");

    expect((await broker.forwardToAdmin({ approvalId: undefined, token, messageId: "om_orig-1", chatId: "oc_group" })).accepted).toBe(false);
  });

  it("通知卡构建（main 层失败文案用）：buildNoticeCard 可用", () => {
    const card = buildNoticeCard("❌ 转发管理员失败：转发失败：open_id 无效");
    expect(JSON.stringify(card)).toContain("转发管理员失败");
  });
});
