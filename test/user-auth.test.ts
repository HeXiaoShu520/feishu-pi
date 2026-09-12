import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogoutCommand, UserAuthService } from "../src/feishu/user-auth.ts";
import type { FeishuInboundMessage } from "../src/feishu/types.ts";

/** 构造注入版 UserAuthService：HTTP 全走脚本应答，时钟/睡眠由测试推进 */
function makeService(opts: {
  storeFile: string;
  postForm: ReturnType<typeof vi.fn>;
  postJson: ReturnType<typeof vi.fn>;
  updateCard: (messageId: string, card: object) => Promise<void>;
}) {
  const clock = { value: 1_000_000 };
  const waits: number[] = [];
  const service = new UserAuthService({
    appId: "cli_test",
    appSecret: "secret",
    scopes: ["contact:user.base:readonly"],
    storeFile: opts.storeFile,
    updateCard: opts.updateCard,
    postForm: opts.postForm,
    postJson: opts.postJson,
    now: () => clock.value,
    // 睡眠即推进假时钟，避免真实等待；同时记录每次轮询间隔供断言
    sleep: async (ms: number) => {
      waits.push(ms);
      clock.value += ms;
    },
  });
  return { service, clock, waits };
}

function message(openId = "ou_test"): FeishuInboundMessage {
  return {
    messageId: "om_test",
    chatId: "oc_test",
    context: { userOpenId: openId, chatId: "oc_test", conversationId: `${openId}-chat:oc_test` },
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

describe("UserAuthService（Device Flow）", () => {
  it("发起授权返回指引卡；轮询 pending→成功后落库并把原卡更新为成功", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uauth-"));
    const updates: Array<{ messageId: string; card: object }> = [];
    const postForm = vi.fn().mockResolvedValue(BEGIN_OK);
    const postJson = vi.fn()
      .mockResolvedValueOnce({ error: "authorization_pending" })
      .mockResolvedValueOnce({ error: "authorization_pending" })
      .mockResolvedValueOnce({
        access_token: "uat_1",
        refresh_token: "urt_1",
        expires_in: 7200,
        refresh_expires_in: 2592000,
        scope: "contact:user.base:readonly",
      });
    const { service } = makeService({
      storeFile: join(dir, "tokens.json"),
      postForm,
      postJson,
      updateCard: async (messageId, card) => {
        updates.push({ messageId, card });
      },
    });

    const result = await service.startLogin(message());
    const content = JSON.stringify(result.card);
    expect(content).toContain("ABCD-1234");
    expect(content).toContain("activate?code=ABCD-1234");

    // 卡片发出后触发后台轮询，等结果落卡
    result.afterSend?.("om_card");
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    // 轮询请求带了 RFC 8628 的 grant_type 与 device_code
    expect(postJson.mock.calls[0][1]).toMatchObject({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "device_abc" });
    expect(JSON.stringify(updates[0].card)).toContain("✅");
    // token 已按 openId 落库
    expect(await service.getUserAccessToken("ou_test")).toBe("uat_1");
  });

  it("slow_down 按 +5s 退避；access_denied 终止并更新失败卡", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uauth-"));
    const updates: Array<{ messageId: string; card: object }> = [];
    const { service, waits } = makeService({
      storeFile: join(dir, "tokens.json"),
      postForm: vi.fn().mockResolvedValue(BEGIN_OK),
      postJson: vi.fn()
        .mockResolvedValueOnce({ error: "slow_down" })
        .mockResolvedValueOnce({ error: "access_denied" }),
      updateCard: async (messageId, card) => {
        updates.push({ messageId, card });
      },
    });

    const result = await service.startLogin(message());
    result.afterSend?.("om_card");
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    // 首次响应即 slow_down：下次轮询前的等待调整为 5s+5s=10s（拒绝后终止，不再等待）
    expect(waits).toEqual([10000]);
    expect(JSON.stringify(updates[0].card)).toContain("拒绝");
    expect(await service.getUserAccessToken("ou_test")).toBeUndefined();
  });

  /** 预写一条临期 token 文件（access 剩 10s < 30s 阈值，refresh 仍有效），格式与 StoredUserToken 一致 */
  async function seedNearExpiry(storeFile: string, now: number, suffix: string): Promise<void> {
    await mkdir(storeFile.split(/[\\/]/).slice(0, -1).join("/"), { recursive: true });
    await writeFile(storeFile, JSON.stringify({
      ou_test: {
        accessToken: `uat_old_${suffix}`,
        refreshToken: `urt_old_${suffix}`,
        expiresAt: now + 10_000,
        refreshExpiresAt: now + 30 * 86_400_000,
        scope: "s1",
        updatedAt: now,
      },
    }), "utf8");
  }

  it("getUserAccessToken 近过期自动刷新", async () => {
    const storeFile = join(await mkdtemp(join(tmpdir(), "uauth-")), "tokens.json");
    const clock = { value: 1_000_000 };
    const postJson = vi.fn();
    const service = new UserAuthService({
      appId: "cli_test",
      appSecret: "secret",
      scopes: ["s1"],
      storeFile,
      updateCard: async () => {},
      postForm: vi.fn(),
      postJson,
      now: () => clock.value,
      sleep: async () => {
        clock.value += 1000;
      },
    });

    await seedNearExpiry(storeFile, clock.value, "a");
    postJson.mockResolvedValueOnce({
      access_token: "uat_new",
      refresh_token: "urt_new",
      expires_in: 7200,
      refresh_expires_in: 2592000,
      scope: "s1",
    });
    expect(await service.getUserAccessToken("ou_test")).toBe("uat_new");
    expect(postJson.mock.calls[0][1]).toMatchObject({ grant_type: "refresh_token", refresh_token: "urt_old_a" });
    // 刷新后的新 token 远未过期 → 再次读取直接命中，不再发请求
    expect(await service.getUserAccessToken("ou_test")).toBe("uat_new");
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it("getUserAccessToken 刷新失败清档返回 undefined", async () => {
    const storeFile = join(await mkdtemp(join(tmpdir(), "uauth-")), "tokens.json");
    const clock = { value: 1_000_000 };
    const postJson = vi.fn();
    const service = new UserAuthService({
      appId: "cli_test",
      appSecret: "secret",
      scopes: ["s1"],
      storeFile,
      updateCard: async () => {},
      postForm: vi.fn(),
      postJson,
      now: () => clock.value,
      sleep: async () => {
        clock.value += 1000;
      },
    });

    await seedNearExpiry(storeFile, clock.value, "b");
    postJson.mockResolvedValueOnce({ error: "invalid_grant" });
    expect(await service.getUserAccessToken("ou_test")).toBeUndefined();
    // 记录已清：再次读取无记录，不再发请求
    expect(await service.getUserAccessToken("ou_test")).toBeUndefined();
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it("/logout 清除登录记录", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uauth-"));
    const postJson = vi.fn().mockResolvedValue({
      access_token: "uat_ok",
      refresh_token: "urt_ok",
      expires_in: 7200,
      refresh_expires_in: 2592000,
      scope: "s1",
    });
    const { service } = makeService({
      storeFile: join(dir, "tokens.json"),
      postForm: vi.fn().mockResolvedValue(BEGIN_OK),
      postJson,
      updateCard: async () => {},
    });

    const result = await service.startLogin(message());
    result.afterSend?.();
    await vi.waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
    expect(await service.getUserAccessToken("ou_test")).toBe("uat_ok");

    const receipt = await new LogoutCommand(service).execute(message());
    expect(JSON.stringify(receipt?.card)).toContain("已退出");
    expect(await service.getUserAccessToken("ou_test")).toBeUndefined();
  });
});
