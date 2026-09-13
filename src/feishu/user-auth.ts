/**
 * 用户飞书身份授权（OAuth 2.0 Device Authorization Grant，RFC 8628）
 *
 * 为什么用 Device Flow：MiniClaw 跑在内网/本机，没有公网回调地址接收标准 OAuth 的
 * 授权码跳转。Device Flow 把"授权动作"交给用户的浏览器/飞书客户端完成，服务器只需
 * 能出网发起请求并轮询，全程不需要 redirect_uri。
 *
 * 端点（与官方 lark-cli 行为一致）：
 * - 发起：POST https://accounts.feishu.cn/oauth/v1/device_authorization（表单编码）
 * - 轮询/刷新：POST https://open.feishu.cn/open-apis/authen/v2/oauth/token（JSON；
 *   authorization_pending / slow_down 等中间态以 HTTP 400 + RFC 风格 error JSON 返回）
 *
 * 安全模型：
 * - device_code 与发起用户的 openId 绑定，token 只落到该用户名下（不接收"代他人授权"）；
 * - scope 由 FEISHU_USER_AUTH_SCOPES 配置，按需最小化申请；
 * - token 落盘在 data/（.gitignore 已排除），对外统一走 getUserAccessToken（近过期静默刷新）；
 *   实际可访问数据 = 应用申请的 scope ∩ 用户本人可见范围，不绕过 Guard 的组策略闸门。
 */
import { logger } from "../utils/logger.ts";
import { JsonMapStore } from "../utils/json-store.ts";
import type { FeishuInboundMessage } from "./types.ts";
import { markdownCard, type CommandHandler, type CommandResult } from "./commands.ts";

const DEVICE_AUTHORIZATION_URL = "https://accounts.feishu.cn/oauth/v1/device_authorization";
const TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** HTTP POST（表单编码）的可注入实现。RFC 8628 的中间态错误随 HTTP 400 返回 body，原样交状态机判断。 */
export type PostForm = (
  url: string,
  form: Record<string, string>,
  headers?: Record<string, string>,
) => Promise<Record<string, unknown>>;

async function defaultPostForm(
  url: string,
  form: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/** 持久化的用户 token（data/user-tokens.json，按 openId 一条） */
export interface StoredUserToken {
  openId: string;
  accessToken: string;
  refreshToken: string;
  /** access_token 过期时刻（ms） */
  expiresAt: number;
  /** refresh_token 过期时刻（ms）；过期后必须重新 /login */
  refreshExpiresAt: number;
  /** 实际授权通过的 scope（空格分隔） */
  scope: string;
  updatedAt: number;
}

class UserTokenStore extends JsonMapStore<StoredUserToken> {
  async get(openId: string): Promise<StoredUserToken | undefined> {
    await this.ensureLoaded();
    return this.records.get(openId);
  }

  async put(token: StoredUserToken): Promise<void> {
    await this.ensureLoaded();
    this.records.set(token.openId, token);
    await this.persist();
  }

  async delete(openId: string): Promise<void> {
    await this.remove(openId);
  }
}

export interface UserAuthOptions {
  appId: string;
  appSecret: string;
  /** /login 时申请的用户身份 scope 列表（需先在开发者后台为应用开通并发布版本） */
  scopes: string[];
  /** token 持久化文件路径 */
  storeFile: string;
  /** 指引卡的原地更新（轮询结束后把"待授权"卡更新为结果卡） */
  updateCard: (messageId: string, card: object) => Promise<void>;
  /** FEISHU_ADMIN 的 openId：其登录 token 用于用户资料查询通道 */
  adminOpenId?: string;
  /** 向会话发送授权卡（增量按需授权时使用）；提供后 ensureScopes 增量授权可用 */
  sendCard?: (chatId: string, card: object) => Promise<string | undefined>;
  /** 轮询基准间隔（秒）；发起响应自带 interval 时优先用响应值 */
  pollIntervalSec?: number;
  /** 以下均为测试注入：HTTP 实现、时钟与睡眠 */
  postForm?: PostForm;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface PendingLogin {
  deviceCode: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 官方要求：申请 scope 必须含 offline_access 才会签发 refresh_token（自动去重追加） */
function withOfflineAccess(scopes: string[]): string {
  return Array.from(new Set([...scopes, "offline_access"])).join(" ");
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export class UserAuthService {
  private readonly store: UserTokenStore;
  private readonly postForm: PostForm;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** 每个用户进行中的授权；同一用户重复 /login 时去重提示，避免叠开轮询 */
  private readonly pending = new Map<string, PendingLogin>();
  private readonly options: UserAuthOptions;

  constructor(options: UserAuthOptions) {
    this.options = options;
    this.store = new UserTokenStore(options.storeFile);
    this.postForm = options.postForm ?? defaultPostForm;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * 发起 Device Flow 授权，返回指引卡（链接 + 确认码）。
   * 卡片发出后后台开始轮询，完成/失败时经 updateCard 把原卡更新为结果，不再占用指令回复。
   */
  async startLogin(message: FeishuInboundMessage): Promise<CommandResult> {
    const openId = message.context.userOpenId;
    if (this.pending.has(openId)) {
      return { card: markdownCard("⏳ 你已有一个进行中的授权，请先在浏览器完成，或稍后再试。") };
    }
    const existing = await this.store.get(openId);
    if (existing && existing.refreshExpiresAt - 60_000 > this.now()) {
      const validUntil = new Date(existing.refreshExpiresAt).toLocaleString("zh-CN");
      return { card: markdownCard(`✅ 你已登录（授权范围：${existing.scope || "默认"}，登录有效期至 ${validUntil}）。\n如需更换身份请先 /logout。`) };
    }

    const begin = await this.postForm(
      DEVICE_AUTHORIZATION_URL,
      {
        client_id: this.options.appId,
        scope: withOfflineAccess(this.options.scopes),
      },
      { Authorization: `Basic ${Buffer.from(`${this.options.appId}:${this.options.appSecret}`).toString("base64")}` },
    );
    const deviceCode = str(begin.device_code);
    if (!deviceCode) {
      const reason = str(begin.error_description) || str(begin.error) || JSON.stringify(begin).slice(0, 200);
      return { card: markdownCard(`❌ 发起授权失败：${reason}\n请检查应用后台是否已开通并发布对应权限，以及 FEISHU_USER_AUTH_SCOPES 配置。`) };
    }

    const intervalMs = (num(begin.interval) || this.options.pollIntervalSec || 5) * 1000;
    const expiresInMs = (num(begin.expires_in) || 300) * 1000;
    const link = str(begin.verification_uri_complete) || str(begin.verification_uri);
    const userCode = str(begin.user_code);

    const lines = ["🔐 **飞书用户身份授权**", ""];
    if (link) lines.push(`请点击链接完成授权：[点此授权](${link})`);
    if (userCode && !str(begin.verification_uri_complete)) lines.push(`或打开 ${str(begin.verification_uri)} 输入确认码：\`${userCode}\``);
    lines.push("", `⏱️ 约 ${Math.round(expiresInMs / 60_000)} 分钟内有效；授权完成后此卡片会自动更新结果。`);

    const entry: PendingLogin = { deviceCode };
    // pending 在卡片真正发出后才登记（afterSend 内），发送失败不会把去重锁留在原地
    this.pending.set(openId, entry);

    return {
      card: markdownCard(lines.join("\n")),
      afterSend: (sentMessageId) => {
        // 后台轮询：结果经 updateCard 原地落卡，指令回复流程不被阻塞
        void this.pollUntilDone(openId, entry, sentMessageId, this.now() + expiresInMs, intervalMs)
          .catch((error) => {
            logger.error("[UserAuth] 授权轮询异常:", error);
          })
          .finally(() => {
            if (this.pending.get(openId) === entry) this.pending.delete(openId);
          });
      },
    };
  }

  /**
   * 取用户的有效 access token；未登录或刷新失败返回 undefined（调用方可引导 /login）。
   * access token 临期（<30s）时用 refresh token 静默换新；refresh token 也失效则清档要求重新登录。
   */
  async getUserAccessToken(openId: string): Promise<string | undefined> {
    const token = await this.store.get(openId);
    if (!token) return undefined;
    const now = this.now();
    if (token.expiresAt - 30_000 > now) return token.accessToken;
    if (token.refreshExpiresAt - 60_000 <= now) {
      await this.store.delete(openId);
      logger.info(`[UserAuth] 用户 ${openId} 的 refresh token 已过期，需要重新 /login`);
      return undefined;
    }

    const res = await this.postForm(TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: this.options.appId,
      client_secret: this.options.appSecret,
    });
    const accessToken = str(res.access_token);
    if (!accessToken) {
      await this.store.delete(openId);
      logger.warn(`[UserAuth] 用户 ${openId} 刷新 token 失败（${str(res.error) || "未知错误"}），需要重新 /login`);
      return undefined;
    }
    const refreshTtlSec = num(res.refresh_token_expires_in) || num(res.refresh_expires_in);
    const updated: StoredUserToken = {
      openId,
      accessToken,
      refreshToken: str(res.refresh_token) || token.refreshToken,
      expiresAt: this.now() + (num(res.expires_in) || 7200) * 1000,
      refreshExpiresAt: refreshTtlSec > 0 ? this.now() + refreshTtlSec * 1000 : token.refreshExpiresAt,
      scope: str(res.scope) || token.scope,
      updatedAt: this.now(),
    };
    await this.store.put(updated);
    return updated.accessToken;
  }

  /**
   * 确保用户具备所需 scope（增量授权）：token 已含全部所需 → 返回 access token；
   * 缺失 → 向当前会话**自动发起新一轮 Device Flow**（合并现有与新增 scope）并立即返回
   * undefined——用户在卡片上同意后 token 更新，调用方下次调用即生效。
   * 这就是"用到啥再申请啥"：能力层只需声明本次需要的 scope，无需用户预先登录。
   */
  async ensureScopes(openId: string, chatId: string, needed: string[]): Promise<string | undefined> {
    if (needed.length === 0) return this.getUserAccessToken(openId);
    const token = await this.store.get(openId);
    const current = token?.scope.split(/\s+/).filter(Boolean) ?? [];
    const missing = needed.filter((s) => !current.includes(s));
    if (token && missing.length === 0) return this.getUserAccessToken(openId);

    // 增量申请范围 = 现有 scope ∪ 新增 scope（避免已同意的权限被缩水）
    const scopes = Array.from(new Set([...current, ...needed]));

    if (this.pending.has(openId)) return undefined; // 已有进行中的授权
    const begin = await this.postForm(
      DEVICE_AUTHORIZATION_URL,
      {
        client_id: this.options.appId,
        scope: withOfflineAccess(scopes),
      },
      { Authorization: `Basic ${Buffer.from(`${this.options.appId}:${this.options.appSecret}`).toString("base64")}` },
    );
    const deviceCode = str(begin.device_code);
    if (!deviceCode) {
      logger.warn(`[UserAuth] 增量授权发起失败：${str(begin.error_description) || str(begin.error) || "未知"}`);
      return undefined;
    }

    const intervalMs = (num(begin.interval) || 5) * 1000;
    const expiresInMs = (num(begin.expires_in) || 300) * 1000;
    const link = str(begin.verification_uri_complete) || str(begin.verification_uri);
    const userCode = str(begin.user_code);
    const lines = ["🔐 **需要补充飞书授权**", ""];
    if (link) lines.push(`请点击链接完成授权：[点此授权](${link})`);
    if (userCode && !str(begin.verification_uri_complete)) lines.push(`或打开 ${str(begin.verification_uri)} 输入确认码：\`${userCode}\``);
    lines.push("", `⏱️ 约 ${Math.round(expiresInMs / 60_000)} 分钟内有效；完成后此卡片自动更新。`);

    const entry: PendingLogin = { deviceCode };
    this.pending.set(openId, entry);

    // 发卡后立即返回（不阻塞调用方）：后台轮询，同意后 token 入库，调用方下次调用即生效
    void (async () => {
      try {
        const messageId = this.options.sendCard
          ? await this.options.sendCard(chatId, markdownCard(lines.join("\n")))
          : undefined;
        await this.pollUntilDone(openId, entry, messageId, this.now() + expiresInMs, intervalMs);
      } catch (error) {
        logger.error("[UserAuth] 增量授权流程异常:", error);
      } finally {
        if (this.pending.get(openId) === entry) this.pending.delete(openId);
      }
    })();
    return undefined;
  }

  /** 清除用户的登录记录。返回是否存在（供 /logout 回执）。 */
  async logout(openId: string): Promise<boolean> {
    const existing = await this.store.get(openId);
    if (!existing) return false;
    await this.store.delete(openId);
    return true;
  }

  /** RFC 8628 轮询状态机：pending 继续、slow_down 退避（+5s）、denied/expired/其它错误终止并落结果卡。 */
  private async pollUntilDone(openId: string, entry: PendingLogin, messageId: string | undefined, deadline: number, baseIntervalMs: number): Promise<void> {
    let waitMs = baseIntervalMs;
    while (this.now() < deadline) {
      await this.sleep(waitMs);
      const res = await this.postForm(TOKEN_URL, {
        grant_type: DEVICE_CODE_GRANT,
        device_code: entry.deviceCode,
        client_id: this.options.appId,
        client_secret: this.options.appSecret,
      });

      const accessToken = str(res.access_token);
      if (accessToken) {
        const token: StoredUserToken = {
          openId,
          accessToken,
          refreshToken: str(res.refresh_token),
          expiresAt: this.now() + (num(res.expires_in) || 7200) * 1000,
          refreshExpiresAt: this.now() + (num(res.refresh_token_expires_in) || num(res.refresh_expires_in) || 30 * 86_400) * 1000,
          scope: str(res.scope) || this.options.scopes.join(" "),
          updatedAt: this.now(),
        };
        await this.store.put(token);
        logger.info(`[UserAuth] 用户 ${openId} 授权成功（scope: ${token.scope || "默认"}）`);
        await this.finishCard(messageId, markdownCard(`✅ 授权成功，用户身份已生效（scope：${token.scope || "默认"}）。`));
        return;
      }

      switch (str(res.error)) {
        case "authorization_pending":
          break;
        case "slow_down":
          waitMs += 5000;
          break;
        case "access_denied":
          await this.finishCard(messageId, markdownCard("❌ 你拒绝了本次授权。需要用户身份能力时请重新 /login。"));
          return;
        case "expired_token":
          await this.finishCard(messageId, markdownCard("❌ 授权链接已过期，请重新 /login。"));
          return;
        default: {
          const reason = str(res.error_description) || str(res.error) || "未知错误";
          await this.finishCard(messageId, markdownCard(`❌ 授权失败：${reason}`));
          return;
        }
      }
    }
    await this.finishCard(messageId, markdownCard("❌ 等待授权超时，请重新 /login。"));
  }

  private async finishCard(messageId: string | undefined, card: object): Promise<void> {
    if (!messageId) return;
    try {
      await this.options.updateCard(messageId, card);
    } catch (error) {
      logger.warn("[UserAuth] 更新授权卡失败:", error);
    }
  }
}

/** /login：发起 Device Flow 授权，把指引卡发给用户；后台轮询完成后原地更新结果。 */
export class LoginCommand implements CommandHandler {
  private readonly auth: UserAuthService;

  constructor(auth: UserAuthService) {
    this.auth = auth;
  }

  match(text: string): boolean {
    return text.trim() === "/login";
  }

  execute(message: FeishuInboundMessage): Promise<CommandResult | null> {
    return this.auth.startLogin(message);
  }
}

/** /logout：清除本人的用户身份登录记录。 */
export class LogoutCommand implements CommandHandler {
  private readonly auth: UserAuthService;

  constructor(auth: UserAuthService) {
    this.auth = auth;
  }

  match(text: string): boolean {
    return text.trim() === "/logout";
  }

  async execute(message: FeishuInboundMessage): Promise<CommandResult | null> {
    const removed = await this.auth.logout(message.context.userOpenId);
    return {
      card: markdownCard(removed ? "✅ 已退出登录，用户授权已清除。需要用户身份能力时请重新 /login。" : "你当前没有登录记录。"),
    };
  }
}
