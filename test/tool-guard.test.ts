import { describe, expect, it } from "vitest";
import { ToolGuard } from "../src/guard/tool-guard.ts";
import { PermissionBroker } from "../src/guard/broker.ts";
import { PolicyJudge } from "../src/guard/judge.ts";
import type { GroupPolicy } from "../src/permission/policy.ts";

/** 用户组策略：bash 仅测试命令、写仅 docs/ */
const userPolicy: GroupPolicy = {
  groups: ["user"],
  isAdmin: false,
  bashAllowed: (c) => c.startsWith("npm run test") && !/[;&|`]|\$\(/.test(c),
  readAllowed: () => true,
  writeAllowed: (p) => p.startsWith("docs/"),
  toolsAllowed: () => true,
  describe: () => ({ bash: ["npm run test:*"], read: ["docs/**"], write: ["docs/**"], tools: ["*"] }),
};

class FakeBroker extends PermissionBroker {
  calls: Array<{ toolName: string; reason: string }> = [];
  constructor() {
    super({ adminOpenIds: [], timeoutMs: 10, sendCard: async () => "m", updateCard: async () => {} });
  }
  async requestApproval(params: { toolName: string; reason: string }) {
    this.calls.push({ toolName: params.toolName, reason: params.reason });
    return { allowed: false, detail: "测试拒绝" };
  }
}

function makeGuard(opts: { judge?: PolicyJudge }) {
  return new ToolGuard(new FakeBroker(), opts.judge);
}

const disabledJudge = new PolicyJudge({ models: [], timeoutMs: 10 }); // 未配置 → enabled false
const judgeAllow = {
  enabled: true,
  judge: async () => ({ decision: "allow", reason: "符合授权意图" }),
} as unknown as PolicyJudge;
const judgeAsk = {
  enabled: true,
  judge: async () => ({ decision: "ask", reason: "测试ask" }),
} as unknown as PolicyJudge;

describe("ToolGuard 策略 + 智能体 + 授权卡", () => {
  it("bash 命中组名单 → 放行", async () => {
    const guard = makeGuard({});
    const result = await guard.check(userPolicy, { toolName: "bash", args: { command: "npm run test -- --watch" } });
    expect(result).toBeUndefined();
  });

  it("策略未命中 + 智能体未启用 → 直接授权卡；无 chatId 时拦截", async () => {
    const guard = makeGuard({ judge: disabledJudge });
    const result = await guard.check(userPolicy, { toolName: "bash", args: { command: "curl example.com" } });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("不在 bash 允许名单内");
  });

  it("策略未命中 → 智能体综合判断 allow → 放行（复合命令场景）", async () => {
    const guard = makeGuard({ judge: judgeAllow });
    const result = await guard.check(userPolicy, { toolName: "bash", args: { command: "npm run test && npm run check" } });
    expect(result).toBeUndefined();
  });

  it("智能体判断 ask → 走授权卡（无 chatId 时拦截）", async () => {
    const guard = makeGuard({ judge: judgeAsk });
    const result = await guard.check(userPolicy, { toolName: "bash", args: { command: "rm -rf /tmp/x" } });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("测试ask");
  });

  it("write 命中组 write 范围放行；范围外交智能体判断", async () => {
    const guard = makeGuard({ judge: judgeAsk });
    const inScope = await guard.check(userPolicy, { toolName: "write", args: { path: "docs/a.md", content: "x" } });
    expect(inScope).toBeUndefined();
    const outScope = await guard.check(userPolicy, { toolName: "write", args: { path: "src/x.ts", content: "x" } });
    expect(outScope?.block).toBe(true);
  });

  it("自定义工具未标 risky → 放行；标 risky → 授权卡", async () => {
    const guard = makeGuard({});
    expect(await guard.check(userPolicy, { toolName: "query-stats", args: { action: "list" } })).toBeUndefined();
    const risky = await guard.check(userPolicy, { toolName: "query-stats", args: { action: "list" }, risky: true });
    expect(risky?.block).toBe(true);
  });
});