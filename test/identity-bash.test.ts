import { describe, expect, it } from "vitest";
import {
  applyCredentialInjections,
  extractMissingScopes,
  matchesUserIdentityCli,
  type ProviderInjection,
} from "../src/runtime/identity-bash.ts";

/** 与 identity-bash.ts 内置规则同构的最小规则集（getToken 由测试注入） */
function makeRules(opts: { token?: string; appId?: string } = {}) {
  return [
    {
      commandPattern: /\blark[-_]?cli\b/,
      excludePattern: /(^|[\s;|&])--as(=|\s+)bot(\s|$)/i,
      envToken: "LARKSUITE_CLI_USER_ACCESS_TOKEN",
      envAppId: "LARKSUITE_CLI_APP_ID",
      appId: opts.appId,
      getToken: () => opts.token,
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

  it("显式 --as bot 不注入（走 lark-cli 自身 bot 身份）", () => {
    const env: NodeJS.ProcessEnv = {};
    applyCredentialInjections("lark-cli --as bot im message create", env, makeRules({ token: "uat_x" }));
    expect(env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBeUndefined();
  });

  it("未登录时拒绝执行，不能回退到 CLI 缓存账号", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => applyCredentialInjections("lark-cli calendar +agenda", env, makeRules({}))).toThrow("当前用户未登录");
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("不污染传入 env 之外的上下文：注入只发生在本次 spawn 的环境对象上", () => {
    const env: NodeJS.ProcessEnv = {};
    applyCredentialInjections("lark-cli calendar +agenda", env, makeRules({ token: "uat_x" }));
    applyCredentialInjections("ls -la", env, makeRules({ token: "uat_x" }));
    // 不匹配时也移除继承的用户 token。
    expect(env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBeUndefined();
  });

  it("extraInjections 扩展位：其他 CLI 可按自己的匹配与 env 映射注入", () => {
    const env: NodeJS.ProcessEnv = {};
    const extra: ProviderInjection = {
      commandPattern: /\bmycli\b/,
      envToken: "MYCLI_TOKEN",
      getToken: () => "tok_mycli",
    };
    applyCredentialInjections("mycli do --thing", env, [
      ...makeRules({ token: "uat_x" }),
      { ...extra, appId: "cli_a" },
    ]);
    expect(env.MYCLI_TOKEN).toBe("tok_mycli");
  });
});

describe("extractMissingScopes（lark-cli 缺权限识别）", () => {
  it("从 missing_scopes JSON 数组提取（去重、剔除 offline_access、上限 5 个）", () => {
    const output = '{"code":99991672,"data":{"missing_scopes":["calendar:calendar:readonly","calendar:calendar:readonly","offline_access","mail:mail:readonly","base:record:retrieve","docs:doc:readonly","task:task:write"]}}';
    expect(extractMissingScopes(output)).toEqual([
      "calendar:calendar:readonly",
      "mail:mail:readonly",
      "base:record:retrieve",
      "docs:doc:readonly",
      "task:task:write",
    ]);
  });

  it("从 hint 文案的 auth login --scope 写法提取", () => {
    expect(extractMissingScopes('请执行 auth login --scope "docs:doc:readonly" 后重试')).toEqual([
      "docs:doc:readonly",
    ]);
  });

  it("无缺失 scope → 空数组", () => {
    expect(extractMissingScopes("ok")).toEqual([]);
  });
});

describe("matchesUserIdentityCli（用户身份 CLI 判定，授权分流用）", () => {
  it("lark-cli 省略身份 / 显式 --as user → 用户身份", () => {
    expect(matchesUserIdentityCli("lark-cli calendar +agenda")).toBe(true);
    expect(matchesUserIdentityCli("lark-cli --as user contact search")).toBe(true);
  });

  it("lark-cli 显式 --as bot 是机器人身份 → 否；非 CLI 命令 → 否", () => {
    expect(matchesUserIdentityCli("lark-cli --as bot im message create")).toBe(false);
    expect(matchesUserIdentityCli("lark-cli --as=bot okr list")).toBe(false);
    expect(matchesUserIdentityCli("ls -la")).toBe(false);
    expect(matchesUserIdentityCli("npm run test")).toBe(false);
  });
});


it("复合命令和伪装成 CLI 的字符串不能由用户自行授权", () => {
  for (const command of ["echo lark-cli", "lark-cli calendar +agenda; rm -rf anything", "lark-cli calendar +agenda > target", "lark-cli $(whoami)"]) {
    expect(matchesUserIdentityCli(command)).toBe(false);
  }
});
