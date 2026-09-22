import { describe, expect, it } from "vitest";
import { ToolGuard } from "../src/guard/tool-guard.ts";
import { PermissionBroker, type ApprovalRequest } from "../src/guard/broker.ts";
import type { PolicyJudge } from "../src/guard/judge.ts";
import type { GroupPolicy } from "../src/permission/policy.ts";

function makePolicy(overrides: Partial<GroupPolicy> = {}): GroupPolicy {
  return {
    groups: ["group"],
    isAdmin: false,
    isTeam: true,
    bashAllowed: (command) => command.startsWith("npm run test") && !/[;&|`]|\$\(/.test(command),
    readAllowed: (path) => path.startsWith("docs/"),
    writeAllowed: (path) => path.startsWith("docs/"),
    toolsAllowed: (name) => name === "memory",
    denied: () => undefined,
    describe: () => ({ bash: ["npm run test:*"], read: ["docs/**"], write: ["docs/**"], tools: ["memory"] }),
    ...overrides,
  };
}

class FakeBroker extends PermissionBroker {
  calls: ApprovalRequest[] = [];
  constructor() {
    super({ adminOpenIds: [], timeoutMs: 10, sendCard: async () => "m", sendCardToUser: async () => "m", updateCard: async () => {} });
  }
  async requestApproval(params: ApprovalRequest, _signal?: AbortSignal) {
    this.calls.push(params);
    return { allowed: false, detail: "测试拒绝" };
  }
}

function fakeJudge(decision: "allow" | "admin" | "user") {
  const calls: unknown[] = [];
  return {
    enabled: true,
    calls,
    judge: async (input: unknown) => { calls.push(input); return { decision, reason: `测试 ${decision}` }; },
  } as unknown as PolicyJudge & { calls: unknown[] };
}

describe("ToolGuard 统一门禁", () => {
  it("白名单命中直接通过，read / 自定义工具同样适用", async () => {
    const guard = new ToolGuard(new FakeBroker());
    const policy = makePolicy();
    expect(await guard.check(policy, { toolName: "bash", args: { command: "npm run test -- --watch" } })).toBeUndefined();
    expect(await guard.check(policy, { toolName: "read", args: { path: "docs/a.md" } })).toBeUndefined();
    expect(await guard.check(policy, { toolName: "memory", args: { action: "get" } })).toBeUndefined();
  });

  it("任何白名单未命中都交给 LLM，且 LLM 能直接放行", async () => {
    const judge = fakeJudge("allow");
    const guard = new ToolGuard(new FakeBroker(), judge);
    const result = await guard.check(makePolicy(), { toolName: "read", args: { path: "src/main.ts" }, risky: true });
    expect(result).toBeUndefined();
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]).toMatchObject({ groups: ["group"], isAdmin: false, risky: true, toolName: "read" });
  });

  it("LLM 要管理员确认时发管理员卡", async () => {
    const broker = new FakeBroker();
    const guard = new ToolGuard(broker, fakeJudge("admin"));
    const result = await guard.check(makePolicy(), { toolName: "write", args: { path: "src/x.ts", content: "x" }, chatId: "oc" });
    expect(result?.block).toBe(true);
    expect(broker.calls).toEqual([expect.objectContaining({ mode: "admin", requesterOpenId: undefined })]);
  });

  it("LLM 要用户确认时只发请求者本人卡", async () => {
    const broker = new FakeBroker();
    const guard = new ToolGuard(broker, fakeJudge("user"));
    const result = await guard.check(makePolicy(), { toolName: "calendar", args: { action: "create" }, chatId: "oc", requesterOpenId: "ou_user" });
    expect(result?.block).toBe(true);
    expect(broker.calls).toEqual([expect.objectContaining({ mode: "self", requesterOpenId: "ou_user" })]);
  });

  it("未配置 LLM 时安全回退管理员卡", async () => {
    const broker = new FakeBroker();
    const guard = new ToolGuard(broker);
    const result = await guard.check(makePolicy(), { toolName: "read", args: { path: "src/main.ts" }, chatId: "oc" });
    expect(result?.block).toBe(true);
    expect(broker.calls[0]).toMatchObject({ mode: "admin" });
  });

  it("deny 始终先于白名单、LLM 和授权卡硬拦截", async () => {
    const broker = new FakeBroker();
    const judge = fakeJudge("allow");
    const guard = new ToolGuard(broker, judge);
    const policy = makePolicy({
      groups: ["admin"],
      isAdmin: true,
      isTeam: false,
      readAllowed: () => true,
      denied: (toolName, args) => toolName === "read" && (args as { path?: string }).path === ".env" ? "Read(**/.env*)" : undefined,
    });
    const result = await guard.check(policy, { toolName: "read", args: { path: ".env" }, chatId: "oc" });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("deny");
    expect(judge.calls).toHaveLength(0);
    expect(broker.calls).toHaveLength(0);
  });
});
