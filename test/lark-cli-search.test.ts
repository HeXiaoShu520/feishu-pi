import { describe, expect, it } from "vitest";
import { createCliSearchUser } from "../src/feishu/lark-cli-search.ts";

const success = JSON.stringify({ data: { users: [{ localized_name: "何小书", department: "研发部" }] } });

describe("createCliSearchUser", () => {
  it("认证失败后强制刷新一次 token，并用新 token 重试同一资料查询", async () => {
    const tokens: string[] = [];
    let calls = 0;
    const search = createCliSearchUser({
      appId: "cli_test",
      cwd: process.cwd(),
      tokenCandidates: () => ["ou_user"],
      getToken: async () => "old-token",
      refreshToken: async () => "new-token",
      run: async (_exe, _args, env) => {
        tokens.push(env.LARKSUITE_CLI_USER_ACCESS_TOKEN!);
        calls += 1;
        if (calls === 1) throw new Error("lark-cli 退出码 3：token_invalid");
        return success;
      },
    });

    await expect(search("ou_user")).resolves.toEqual({ name: "何小书", department_name: ["研发部"] });
    expect(tokens).toEqual(["old-token", "new-token"]);
  });

  it("本人就是管理员时，对同一候选只查询一次", async () => {
    let calls = 0;
    const search = createCliSearchUser({
      appId: "cli_test",
      cwd: process.cwd(),
      tokenCandidates: () => ["ou_user", "ou_user"],
      getToken: async () => "token",
      run: async () => { calls += 1; return success; },
    });

    await expect(search("ou_user")).resolves.toEqual({ name: "何小书", department_name: ["研发部"] });
    expect(calls).toBe(1);
  });

  it("按候选顺序优先使用管理员 token，管理员不可见时才回退目标本人", async () => {
    const tokens: string[] = [];
    const search = createCliSearchUser({
      appId: "cli_test",
      cwd: process.cwd(),
      tokenCandidates: () => ["ou_admin", "ou_sender"],
      getToken: async (openId) => openId === "ou_admin" ? "admin-token" : "sender-token",
      run: async (_exe, _args, env) => {
        tokens.push(env.LARKSUITE_CLI_USER_ACCESS_TOKEN!);
        if (env.LARKSUITE_CLI_USER_ACCESS_TOKEN === "admin-token") throw new Error("permission denied");
        return success;
      },
    });

    await expect(search("ou_sender")).resolves.toEqual({ name: "何小书", department_name: ["研发部"] });
    expect(tokens).toEqual(["admin-token", "sender-token"]);
  });
});
