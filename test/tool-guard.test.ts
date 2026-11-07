import { describe, expect, it } from "vitest";
import { ToolGuard, createToolCallLimiter } from "../src/guard/tool-guard.ts";
import { PermissionBroker, type ApprovalRequest } from "../src/guard/broker.ts";
import type { PolicyJudge } from "../src/guard/judge.ts";
import type { ToolPolicy } from "../src/permission/policy.ts";

function makePolicy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return {
    valid: true,
    bashAllowed: (command) => command.startsWith("npm run test") && !/[;&|`]|\$\(/.test(command),
    readAllowed: (path) => path.startsWith("docs/"),
    writeAllowed: (path) => path.startsWith("docs/"),
    toolsAllowed: (name) => name === "memory",
    denied: () => undefined,
    asked: () => undefined,
    describe: () => ({ bash: ["npm run test:*"], read: ["docs/**"], write: ["docs/**"], tools: ["memory"] }),
    ...overrides,
  };
}

class FakeBroker extends PermissionBroker {
  calls: ApprovalRequest[] = [];
  constructor() {
    super({ ownerOpenId: "ou_user", timeoutMs: 10, sendCard: async () => "m", updateCard: async () => {} });
  }
  async requestApproval(params: ApprovalRequest, _signal?: AbortSignal) {
    this.calls.push(params);
    return { allowed: false, detail: "测试拒绝" };
  }
}

function fakeJudge(decision: "allow" | "confirm" | "deny") {
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

  it("ask 命中才交给模型，模型可以放行", async () => {
    const judge = fakeJudge("allow");
    const guard = new ToolGuard(new FakeBroker(), judge);
    const result = await guard.check(makePolicy({ asked: () => "Read(src/**)" }), { toolName: "read", args: { path: "src/main.ts" } });
    expect(result).toBeUndefined();
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]).toMatchObject({ askRule: "Read(src/**)", risky: false, toolName: "read" });
  });

  it("模型要求确认时发本人卡", async () => {
    const broker = new FakeBroker();
    const guard = new ToolGuard(broker, fakeJudge("confirm"));
    const result = await guard.check(makePolicy({ asked: () => "Write(**)" }), { toolName: "write", args: { path: "src/x.ts", content: "x" }, chatId: "oc", requesterOpenId: "ou_user" });
    expect(result?.block).toBe(true);
    expect(broker.calls).toEqual([expect.objectContaining({ requesterOpenId: "ou_user" })]);
  });

  it("高风险标记强制本人确认", async () => {
    const broker = new FakeBroker();
    const guard = new ToolGuard(broker, fakeJudge("confirm"));
    const result = await guard.check(makePolicy(), { toolName: "calendar", args: { action: "create" }, risky: true, chatId: "oc", requesterOpenId: "ou_user" });
    expect(result?.block).toBe(true);
    expect(broker.calls).toEqual([expect.objectContaining({ requesterOpenId: "ou_user" })]);
  });

  it("ask 未配置模型时回退本人确认", async () => {
    const broker = new FakeBroker();
    const guard = new ToolGuard(broker);
    const result = await guard.check(makePolicy({ asked: () => "Read(src/**)" }), { toolName: "read", args: { path: "src/main.ts" }, chatId: "oc", requesterOpenId: "ou_user" });
    expect(result?.block).toBe(true);
    expect(broker.calls[0]).toMatchObject({ requesterOpenId: "ou_user" });
  });

  it("deny 直接拒绝，不调用模型或发授权卡", async () => {
    const broker = new FakeBroker();
    const judge = fakeJudge("confirm");
    const guard = new ToolGuard(broker, judge);
    const policy = makePolicy({
      readAllowed: () => true,
      denied: (toolName, args) => toolName === "read" && (args as { path?: string }).path === ".env" ? "Read(**/.env*)" : undefined,
    });
    const result = await guard.check(policy, { toolName: "read", args: { path: ".env" }, chatId: "oc", requesterOpenId: "ou_user" });
    expect(result?.block).toBe(true);
    expect(judge.calls).toEqual([]);
    expect(broker.calls).toEqual([]);
  });
});

describe("createToolCallLimiter 单轮预算", () => {
  it("上限内放行（undefined），超限 block 且理由含上限值", () => {
    const limiter = createToolCallLimiter(3);
    expect(limiter.check("read", "oc")).toBeUndefined();
    expect(limiter.check("read", "oc")).toBeUndefined();
    expect(limiter.check("bash", "oc")).toBeUndefined();
    const blocked = limiter.check("bash", "oc");
    expect(blocked).toBeDefined();
    expect(blocked).toContain("3");
    // 超限后继续拦
    expect(limiter.check("read", "oc")).toBeDefined();
  });

  it("reset 清零：超限后 reset 恢复放行", () => {
    const limiter = createToolCallLimiter(1);
    expect(limiter.check("read", "oc")).toBeUndefined();
    expect(limiter.check("read", "oc")).toBeDefined();
    limiter.reset("oc");
    expect(limiter.check("read", "oc")).toBeUndefined();
  });

  it("按 chatId 隔离：一个会话超限不影响其他会话", () => {
    const limiter = createToolCallLimiter(1);
    expect(limiter.check("read", "oc_a")).toBeUndefined();
    expect(limiter.check("read", "oc_a")).toBeDefined();
    expect(limiter.check("read", "oc_b")).toBeUndefined();
  });

  it("无 chatId → 全局键计数，与带 chatId 的互不干扰", () => {
    const limiter = createToolCallLimiter(1);
    expect(limiter.check("read")).toBeUndefined();
    expect(limiter.check("read")).toBeDefined();
    expect(limiter.check("read", "oc_x")).toBeUndefined();
  });
});
