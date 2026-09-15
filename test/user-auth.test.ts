import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginCommand, LogoutCommand, UserAuthService } from "../src/feishu/user-auth.ts";
import type { FeishuInboundMessage } from "../src/feishu/types.ts";

/** 构造注入版 UserAuthService：HTTP 全走脚本应答（postForm：第 1 次为 begin，其余为轮询/刷新） */
function makeService(opts: {
  dir: string;
  postForm: ReturnType<typeof vi.fn>;
  updateCard: (messageId: string, card: object) => Promise<void>;
  sendCard?: (chatId: string, card: object) => Promise<string | undefined>;
  /** 实际授权者身份（默认=发起人本人） */
  identityOpenId?: string;
}) {
  const clock = { value: 1_000_000 };
  const service = new UserAuthService({
    appId: "cli_test",
    appSecret: "secret",
    scopes: ["contact:user.base:readonly"],
    vaultFile: join(opts.dir, "credentials.vault.json"),
    vaultKeyFile: join(opts.dir, ".vault-key"),
    legacyTokenFile: join(opts.dir, "user-tokens.json"),
    updateCard: opts.updateCard,
    sendCard: opts.sendCard,
    postForm: opts.postForm,
    getIdentity: async () => ({ openId: opts.identityOpenId ?? "ou_test", name: "测试用户" }),
    now: () => clock.value,
    sleep: async (ms: number) => {
      clock.value += ms;
    },
  });
  return { service, clock };
}

function message(openId = "ou_test"): FeishuInboundMessage {
  return {
    messageId: "om_test",
    chatId: "oc_test",
    context: { userOpenId: openId, chatId: "oc_test", chatMode: "p2p", conversationId: `${openId}-chat:oc_test` },
    text: "/login",
  } as FeishuInboundMessage;
}

const BEGIN_OK = {
  device_code: "device_abc",
  user_code: "ABCD-1234",
  verification_uri: "https://accounts.feishu.cn/activate",
  verification_uri_complete: "https://accounts.feishu.cn/activate?code=ABCD-1234",
  expires_in: 300,
  interval: 5,
};

const TOKEN_OK = {
  access_token: "uat_1",
  refresh_token: "urt_1",
  expires_in: 7200,
  refresh_token_expires_in: 2592000,
  scope: "contact:user.base:readonly offline_access",
};

describe("UserAuthService（Device Flow）", () => {
  it("发起授权返回指引卡；轮询 pending→成功后落库并把原卡更新为成功", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uauth-"));
    const updates: Array<{ messageId: string; card: object }> = [];
    const postForm = vi.fn()
      .mockResolvedValueOnce(BEGIN_OK)
      .mockResolvedValueOnce({ error: "authorization_pending" })
      .mockResolvedValueOnce({ error: "authorization_pending" })
      .mockResolvedValueOnce(TOKEN_OK);
    const { service } = makeService({
      dir,
      postForm,
      updateCard: async (messageId, card) => {
        updates.push({ messageId, card });
      },
    });

    const result = await service.startLogin(message());
    const content = JSON.stringify(result.card);
    expect(content).toContain("ABCD-1234");
    expect(content).toContain("activate?code=ABCD-1234");

    result.afterSend?.("om_card");
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    // begin：自动追加 offline_access（否则不签发 refresh_token）
    expect(postForm.mock.calls[0][1].scope).toBe("contact:user.base:readonly offline_access");
    // 轮询请求带 RFC 8628 的 grant_type 与 device_code（表单编码）
    expect(postForm.mock.calls[1][1]).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "device_abc",
    });
    expect(JSON.stringify(updates[0].card)).toContain("✅");
    expect(await service.getUserAccessToken("ou_test")).toBe("uat_1");
  });

  it("slow_down 按 +5s 退避；access_denied 终止并更新失败卡", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uauth-"));
    const updates: Array<{ messageId: string; card: object }> = [];
    const postForm = vi.fn()
      .mockResolvedValueOnce(BEGIN_OK)
      .mockResolvedValueOnce({ error: "slow_down" })
      .mockResolvedValueOnce({ error: "access_denied" });
    const { service } = makeService({
      dir,
      postForm,
      updateCard: async (messageId, card) => {
        updates.push({ messageId, card });
      },
    });

    const result = await service.startLogin(message());
    result.afterSend?.("om_card");
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    // 先睡后问：首轮 5s；slow_down 后 +5s = 10s
    expect(postForm).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(updates[0].card)).toContain("拒绝");
    expect(await service.getUserAccessToken("ou_test")).toBeUndefined();
  });
  it("群聊中 /login → 拒绝并提示转私聊（授权卡不进群）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uauth-"));
    const postForm = vi.fn();
    const { service } = makeService({ dir, postForm, updateCard: async () => {} });
    const msg = message();
    msg.context.chatMode = "group";
    const result = await service.startLogin(msg);
    expect(JSON.stringify(result.card)).toContain("私聊");
    expect(postForm).not.toHaveBeenCalled();
  });
});

describe("UserAuthService 增量授权（ensureScopes）", () => {
  const VALID_TOKEN = {
    openId: "ou_test",
    accessToken: "uat_old",
    refreshToken: "urt_old",
    expiresAt: 9_000_000,
    refreshExpiresAt: 9_500_000,
    scope: "s1",
    updatedAt: 1_000_000,
  };

  /**
   * 预置旧明文 token 文件（历史格式）：service 首次访问时自动迁入加密凭证库，
   * 顺带覆盖"明文迁移"路径的回归。
   */
  async function seed(dir: string): Promise<void> {
    await writeFile(join(dir, "user-tokens.json"), JSON.stringify({ ou_test: VALID_TOKEN }), "utf8");
  }

  it("scope 已覆盖 → 直接返回 token，不发起授权", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uauth-"));
    await seed(dir);
    const postForm = vi.fn();
    const sendCard = vi.fn();
    const { service } = makeService({ dir, postForm, updateCard: async () => {}, sendCard });

    const token = await service.ensureScopes("ou_test", ["s1"]);
    expect(token).toBe("uat_old");
    expect(postForm).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
  });

  it("缺失 scope → 自动发增量授权卡；同意后合并入库，下次调用生效", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uauth-"));
    await seed(dir);
    const updates: object[] = [];
    const sentCards: object[] = [];
    const postForm = vi.fn()
      .mockResolvedValueOnce({
        device_code: "dc_9",
        user_code: "CODE-9",
        verification_uri_complete: "https://accounts.feishu.cn/activate?code=CODE-9",
        expires_in: 300,
        interval: 5,
      })
      .mockResolvedValueOnce({
        access_token: "uat_new",
        refresh_token: "urt_new",
        expires_in: 7200,
        refresh_token_expires_in: 2592000,
        scope: "s1 s2 offline_access",
      });
    const { service } = makeService({
      dir,
      postForm,
      updateCard: async (_messageId, card) => {
        updates.push(card);
      },
      sendCard: async (_chatId, card) => {
        sentCards.push(card);
        return "om_auth";
      },
    });

    // 缺 s2：立即返回 undefined（本次调用拿不到），同时自动发卡并后台轮询
    const token = await service.ensureScopes("ou_test", ["s2"]);
    expect(token).toBeUndefined();
    expect(sentCards).toHaveLength(1);
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    // 增量申请范围 = 现有 ∪ 新增 ∪ offline_access
    expect(postForm.mock.calls[0][1].scope).toBe("s1 s2 offline_access");
    // 同意后新 token 入库（scope 合并），下次调用直接返回新 token
    expect(await service.getUserAccessToken("ou_test")).toBe("uat_new");
    const stored = await service.getStoredUserToken("ou_test");
    expect(stored?.scope).toBe("s1 s2 offline_access");
    expect(JSON.stringify(updates[0])).toContain("✅");
  });
});


  it("链接被他人代点 → token 绑定实际授权账号（人人可绑定自己的飞书）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uauth-"));
    const updates: object[] = [];
    const postForm = vi.fn()
      .mockResolvedValueOnce(BEGIN_OK)
      .mockResolvedValueOnce(TOKEN_OK);
    const { service } = makeService({
      dir,
      postForm,
      updateCard: async (_messageId, card) => {
        updates.push(card);
      },
      identityOpenId: "ou_B",
    });

    // 发起人是 ou_A，但实际由 ou_B 在浏览器点同意 → token 落到 ou_B 名下
    const result = await service.startLogin(message("ou_A"));
    result.afterSend?.("om_card");
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    expect(JSON.stringify(updates[0])).toContain("已绑定账号");
    expect(await service.getUserAccessToken("ou_B")).toBe("uat_1");
    expect(await service.getUserAccessToken("ou_A")).toBeUndefined();
  });

describe("getUserAccessToken 刷新", () => {
  it("近过期自动刷新（表单编码）；刷新失败清档返回 undefined", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uauth-"));
    // 旧明文格式写入 legacy 文件：service 首次访问自动迁入加密库（迁移路径回归）
    const nowMs = Date.now();
    await writeFile(join(dir, "user-tokens.json"), JSON.stringify({
      ou_test: {
        openId: "ou_test",
        accessToken: "uat_old",
        refreshToken: "urt_old",
        expiresAt: nowMs + 10_000,
        refreshExpiresAt: nowMs + 30 * 86_400_000,
        scope: "s1",
        updatedAt: nowMs,
      },
    }), "utf8");

    const postForm = vi.fn().mockResolvedValueOnce({
      access_token: "uat_new",
      refresh_token: "urt_new",
      expires_in: 7200,
      refresh_token_expires_in: 2592000,
      scope: "s1",
    });
    const service = new UserAuthService({
      appId: "cli_test",
      appSecret: "secret",
      scopes: ["s1"],
      vaultFile: join(dir, "credentials.vault.json"),
      vaultKeyFile: join(dir, ".vault-key"),
      legacyTokenFile: join(dir, "user-tokens.json"),
      updateCard: async () => {},
      postForm,
    });

    expect(await service.getUserAccessToken("ou_test")).toBe("uat_new");
    expect(postForm.mock.calls[0][1]).toMatchObject({ grant_type: "refresh_token", refresh_token: "urt_old" });

    // 刷新失败 → 清档返回 undefined；再查无记录，不再发请求（第二个独立目录，避免读到上一份加密库）
    const dir2 = await mkdtemp(join(tmpdir(), "uauth-"));
    await writeFile(join(dir2, "user-tokens.json"), JSON.stringify({
      ou_test: {
        openId: "ou_test",
        accessToken: "uat_old2",
        refreshToken: "urt_old2",
        expiresAt: nowMs + 10_000,
        refreshExpiresAt: nowMs + 30 * 86_400_000,
        scope: "s1",
        updatedAt: nowMs,
      },
    }), "utf8");
    const postFormFail = vi.fn().mockResolvedValue({ error: "invalid_grant" });
    const service2 = new UserAuthService({
      appId: "cli_test",
      appSecret: "secret",
      scopes: ["s1"],
      vaultFile: join(dir2, "credentials.vault.json"),
      vaultKeyFile: join(dir2, ".vault-key"),
      legacyTokenFile: join(dir2, "user-tokens.json"),
      updateCard: async () => {},
      postForm: postFormFail,
    });
    expect(await service2.getUserAccessToken("ou_test")).toBeUndefined();
    expect(await service2.getUserAccessToken("ou_test")).toBeUndefined();
    expect(postFormFail).toHaveBeenCalledTimes(1);
  });

  it("/logout 清除登录记录", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uauth-"));
    const postForm = vi.fn()
      .mockResolvedValueOnce(BEGIN_OK)
      .mockResolvedValue(TOKEN_OK);
    const { service } = makeService({
      dir,
      postForm,
      updateCard: async () => {},
    });

    const result = await service.startLogin(message());
    result.afterSend?.("om_card");
    await vi.waitFor(() => expect(postForm).toHaveBeenCalledTimes(2));
    expect(await service.getUserAccessToken("ou_test")).toBe("uat_1");

    const receipt = await new LogoutCommand(service).execute(message());
    expect(JSON.stringify(receipt?.card)).toContain("已清除你的全部登录凭证");
    expect(await service.getUserAccessToken("ou_test")).toBeUndefined();
  });
});

describe("/login 指令路由（provider 后缀必填）", () => {
  it("无参数 /login 不默认任何应用，返回支持清单引导", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uauth-route-"));
    const { service } = makeService({ dir, postForm: vi.fn(), updateCard: async () => {} });
    const cmd = new LoginCommand(service);
    const result = await cmd.execute(message());
    expect(JSON.stringify(result?.card)).toContain("/login lark");
    expect(JSON.stringify(result?.card)).toContain("/login meegle");
  });

  it("/login 未知应用返回支持清单", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uauth-route-"));
    const { service } = makeService({ dir, postForm: vi.fn(), updateCard: async () => {} });
    const cmd = new LoginCommand(service);
    const msg = message();
    msg.text = "/login foobar";
    const result = await cmd.execute(msg);
    expect(JSON.stringify(result?.card)).toContain("未知的应用");
  });

  it("/login meegle 返回接入中占位卡，不发起授权请求", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uauth-route-"));
    const postForm = vi.fn();
    const { service } = makeService({ dir, postForm, updateCard: async () => {} });
    const cmd = new LoginCommand(service);
    const msg = message();
    msg.text = "/login meegle";
    const result = await cmd.execute(msg);
    expect(JSON.stringify(result?.card)).toContain("Meegle");
    expect(postForm).not.toHaveBeenCalled();
  });

  it("/login lark 正常路由到飞书授权", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uauth-route-"));
    const postForm = vi.fn().mockResolvedValueOnce(BEGIN_OK);
    const { service } = makeService({ dir, postForm, updateCard: async () => {} });
    const cmd = new LoginCommand(service);
    const msg = message();
    msg.text = "/login lark";
    const result = await cmd.execute(msg);
    expect(JSON.stringify(result?.card)).toContain("ABCD-1234");
    expect(postForm).toHaveBeenCalledTimes(1);
  });
});

describe("/login 去重锁生命周期", () => {
  it("卡片发送失败不残留锁；发出后锁定去重；轮询结束释放", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uauth-lock-"));
    // 手工构造：sleep 用门控（不放行就不轮询），保证断言时序确定
    let releaseNextSleep: () => void = () => undefined;
    const postForm = vi.fn()
      .mockResolvedValueOnce(BEGIN_OK)                          // 第一次发起
      .mockResolvedValueOnce(BEGIN_OK)                          // 第二次发起（重试）
      .mockResolvedValueOnce({ error: "authorization_pending" }) // 轮询 1：继续等待
      .mockResolvedValueOnce({ error: "access_denied" })         // 轮询 2：拒绝 → 终止并释放锁
      .mockResolvedValueOnce(BEGIN_OK);                          // 场景 3：重新发起
    const service = new UserAuthService({
      appId: "cli_test",
      appSecret: "secret",
      scopes: ["contact:user.base:readonly"],
      vaultFile: join(dir, "credentials.vault.json"),
      vaultKeyFile: join(dir, ".vault-key"),
      legacyTokenFile: join(dir, "user-tokens.json"),
      updateCard: async () => {},
      postForm,
      getIdentity: async () => ({ openId: "ou_test", name: "测试用户" }),
      now: () => Date.now(),
      sleep: () => new Promise<void>((resolve) => { releaseNextSleep = resolve; }),
    });

    const first = await service.startLogin(message());
    // 场景 1：第一次卡片发送失败（afterSend 未被调用）→ 立即重试不得被锁死
    const retry = await service.startLogin(message());
    expect(JSON.stringify(retry.card)).not.toContain("进行中的授权");

    // 场景 2：重试卡片发出 → 锁定去重（轮询卡在 sleep，锁保持）
    retry.afterSend?.("om_retry");
    const during = await service.startLogin(message());
    expect(JSON.stringify(during.card)).toContain("进行中的授权");

    // 放行轮询：pending → 继续等待 → 拒绝 → 轮询终止并释放锁
    releaseNextSleep();
    await new Promise((r) => setTimeout(r, 0)); // 让轮询消费完本轮、挂到下一次 sleep
    releaseNextSleep();
    await vi.waitFor(() => expect(postForm).toHaveBeenCalledTimes(4));

    // 场景 3：锁已释放（无 token，走正常重新发起而非"进行中"提示）
    const after = await service.startLogin(message());
    expect(JSON.stringify(after.card)).not.toContain("进行中的授权");
    void first;
  });
});
