import { describe, expect, it } from "vitest";
import { applyCredentialInjections } from "../src/runtime/identity-bash.ts";

/** 与 identity-bash.ts 内置规则同构的最小规则集（getToken 由测试注入） */
function makeRules(opts: { token?: string; appId?: string; meegleToken?: string } = {}) {
  return [
    {
      commandPattern: /\blark[-_]?cli\b/,
      excludePattern: /(^|[\s;|&])--as(=|\s+)bot(\s|$)/i,
      envToken: "LARKSUITE_CLI_USER_ACCESS_TOKEN",
      envAppId: "LARKSUITE_CLI_APP_ID",
      appId: opts.appId,
      getToken: () => opts.token,
    },
    {
      commandPattern: /\bmeegle\b/,
      envToken: "MEEGLE_USER_ACCESS_TOKEN",
      getToken: () => opts.meegleToken,
    },
  ];
}

describe("applyCredentialInjections（会话 bash 身份注入）", () => {
  it("省略身份的 lark-cli 命令 → 注入发起人 token 与 appId", () => {
    const env: NodeJS.ProcessEnv = {};
    applyCredentialInjections("lark-cli calendar +agenda", env, makeRules({ token: "uat_x", appId: "cli_a" }));
    expect(env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBe("uat_x");
    expect(env.LARKSUITE_CLI_APP_ID).toBe("cli_a");
  });

  it("显式 --as bot → 不注入（走 lark-cli 自身 bot 身份）", () => {
    const env: NodeJS.ProcessEnv = {};
    applyCredentialInjections("lark-cli --as bot im message create --content hi", env, makeRules({ token: "uat_x", appId: "cli_a" }));
    expect(env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBeUndefined();
    expect(env.LARKSUITE_CLI_APP_ID).toBeUndefined();
  });

  it("--as=bot 等号写法同样排除；--as user 显式写法正常注入", () => {
    const envEq: NodeJS.ProcessEnv = {};
    applyCredentialInjections("lark-cli --as=bot okr list", envEq, makeRules({ token: "uat_x" }));
    expect(envEq.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBeUndefined();

    const envUser: NodeJS.ProcessEnv = {};
    applyCredentialInjections("lark-cli --as user calendar +agenda", envUser, makeRules({ token: "uat_x" }));
    expect(envUser.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBe("uat_x");
  });

  it("命令分隔符后的 --as bot（混合命令）也整体排除注入（宁缺毋滥，避免身份错位）", () => {
    const env: NodeJS.ProcessEnv = {};
    applyCredentialInjections(
      "lark-cli --as bot im message create --content hi && lark-cli calendar +agenda",
      env,
      makeRules({ token: "uat_x" }),
    );
    expect(env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBeUndefined();
  });

  it("非 lark-cli 命令不注入；meegle 命令走自己的 provider 规则", () => {
    const env: NodeJS.ProcessEnv = {};
    applyCredentialInjections("meegle mywork todo --action this_week", env, makeRules({ token: "uat_x", meegleToken: "mtok" }));
    expect(env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBeUndefined();
    expect(env.MEEGLE_USER_ACCESS_TOKEN).toBe("mtok");
  });

  it("未登录（无 token）→ 任何命令都不注入", () => {
    const env: NodeJS.ProcessEnv = {};
    applyCredentialInjections("lark-cli calendar +agenda", env, makeRules({}));
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("不污染传入 env 之外的上下文：注入只发生在本次 spawn 的环境对象上", () => {
    const env: NodeJS.ProcessEnv = {};
    applyCredentialInjections("lark-cli calendar +agenda", env, makeRules({ token: "uat_x" }));
    applyCredentialInjections("ls -la", env, makeRules({ token: "uat_x" }));
    // 第二次命令不匹配 → 保留第一次的值不变（env 是本次 spawn 专属对象）
    expect(env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBe("uat_x");
  });
});
