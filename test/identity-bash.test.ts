import { describe, expect, it } from "vitest";
import { applyCredentialInjections, extractMissingScopes, matchesUserIdentityCli } from "../src/runtime/identity-bash.ts";

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

describe("extractMissingScopes（lark-cli 缺权限识别）", () => {
  it("missing_scopes 数组：提取全部候选 scope，去重", () => {
    const output = `{"code":99991672,"msg":"Permission denied","error":{"missing_scopes":["docs:doc:readonly","docs:doc:readonly","drive:drive:readonly"]}}`;
    expect(extractMissingScopes(output)).toEqual(["docs:doc:readonly", "drive:drive:readonly"]);
  });

  it("hint 中的 auth login --scope 写法兜底；offline_access 不需要补授权", () => {
    const output = `权限不足。hint: lark-cli auth login --scope "calendar:calendar:readonly" --no-wait --json`;
    expect(extractMissingScopes(output)).toEqual(["calendar:calendar:readonly"]);
    expect(extractMissingScopes('"missing_scopes":["offline_access"]')).toEqual([]);
  });

  it("普通输出/成功输出 → 空列表（不触发补授权）", () => {
    expect(extractMissingScopes('{"ok":true,"data":{"items":[]}}')).toEqual([]);
    expect(extractMissingScopes("命令执行完成")).toEqual([]);
  });
});

describe("envFields 多字段注入（bbt 明文参数型 CLI）", () => {
  const bbtRule = (fields?: Record<string, string>) => ({
    commandPattern: /\bbbt\b/,
    envFields: {
      get: () => fields,
      map: { username: "BBT_USERNAME", password: "BBT_PASSWORD" },
    },
    staticEnv: { BBT_SITE: "bitbucket.org" },
  });

  it("命令命中 → 字段值映射为环境变量；命令文本不含真实值", () => {
    const env: NodeJS.ProcessEnv = {};
    applyCredentialInjections(
      'bbt pr create -r myrepo --user "$BBT_USERNAME" --password "$BBT_PASSWORD"',
      env,
      [bbtRule({ username: "alice", password: "s3cret" })],
    );
    expect(env.BBT_USERNAME).toBe("alice");
    expect(env.BBT_PASSWORD).toBe("s3cret");
    expect(env.BBT_SITE).toBe("bitbucket.org");
  });

  it("缺一个字段只跳过该变量；完全无凭证不注入也不写 staticEnv", () => {
    const partial: NodeJS.ProcessEnv = {};
    applyCredentialInjections("bbt pr list", partial, [bbtRule({ username: "alice" })]);
    expect(partial.BBT_USERNAME).toBe("alice");
    expect(partial.BBT_PASSWORD).toBeUndefined();
    expect(partial.BBT_SITE).toBe("bitbucket.org");

    const none: NodeJS.ProcessEnv = {};
    applyCredentialInjections("bbt pr list", none, [bbtRule(undefined)]);
    expect(Object.keys(none)).toHaveLength(0);
  });

  it("单 token 与多字段可并存于同一规则；非本 CLI 命令不注入", () => {
    const combined = {
      commandPattern: /\bmycli\b/,
      envToken: "MYCLI_TOKEN" as const,
      getToken: () => "tok",
      envFields: { get: () => ({ user: "u1" }), map: { user: "MYCLI_USER" } },
    };
    const env: NodeJS.ProcessEnv = {};
    applyCredentialInjections("mycli do", env, [combined]);
    expect(env.MYCLI_TOKEN).toBe("tok");
    expect(env.MYCLI_USER).toBe("u1");

    const other: NodeJS.ProcessEnv = {};
    applyCredentialInjections("ls -la", other, [bbtRule({ username: "a", password: "b" })]);
    expect(Object.keys(other)).toHaveLength(0);
  });
});

describe("matchesUserIdentityCli（用户身份 CLI 判定，授权分流用）", () => {
    it("meegle / bbt 恒为用户身份；lark-cli 省略身份为用户身份", () => {
    expect(matchesUserIdentityCli("meegle mywork todo")).toBe(true);
    expect(matchesUserIdentityCli('bbt pr create -r x --user "$BBT_USERNAME" --password "$BBT_PASSWORD"')).toBe(true);
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
