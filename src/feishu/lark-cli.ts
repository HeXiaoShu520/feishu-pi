import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { logger } from "../utils/logger.ts";

export interface LarkUserProfile {
  openId: string;
  name?: string;           // 中文名
  englishName?: string;    // 英文名
  departmentNames?: string[]; // 部门中文名列表（仅历史缓存可能保留；新查询不再获取，需部门数据时应为应用开通通讯录部门权限后经 contact API 查询）
  /** 信息查询或更新时间（ISO 8601） */
  updatedAt: string;
}

/** 单次查询通道的返回：命中的资料字段（各通道按能力尽量填充） */
interface ProfileName {
  name?: string;
  englishName?: string;
  departmentNames?: string[];
}

/** 管理员身份查询的可注入 HTTP GET：v3 响应的 data 层已拆包返回 */
export type AdminGet = (pathAndQuery: string, token: string) => Promise<Record<string, unknown>>;

export interface LarkCliOptions {
  /**
   * 管理员用户 token 提供器（来自 /login，FEISHU_ADMIN 的 user_access_token）。
   * 提供后启用管理员身份查询通道（用户资料查询的唯一通道）：
   * 查中文名/英文名/部门名，数据范围 = 管理员的组织架构可见范围；未 /login 时资料退化为仅 openId。
   */
  adminTokenProvider?: () => Promise<string | undefined>;
  /** 测试注入：管理员身份的 HTTP GET 实现（默认全局 fetch 直连 open.feishu.cn） */
  adminGet?: AdminGet;
}

async function defaultAdminGet(pathAndQuery: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://open.feishu.cn${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown> };
  // v3 接口响应为 { code, msg, data }，失败/限流也返回 body 交由调用方判空
  return (body.data ?? body) as Record<string, unknown>;
}

const CACHE_EXPIRY_DAYS = 3;
/** 空档案（三级查询均未命中的最小资料）的重查间隔：信息可能随时变得可查，更快重试 */
const SPARSE_CACHE_EXPIRY_DAYS = 1;

/** 空档案判定：无名字、无英文名、无部门（仅 openId） */
function isSparseProfile(profile: LarkUserProfile): boolean {
  return !profile.name && !profile.englishName && !profile.departmentNames?.length;
}

/** 所有用户资料的缓存结构（以 openId 为键） */
interface UserProfileCache {
  [openId: string]: LarkUserProfile;
}

/** 用户信息查询和缓存管理 */
export class LarkCli {
  private readonly cacheFilePath: string;
  private cache: UserProfileCache = {};
  private cacheLoaded = false;
  private readonly client: Client;
  private readonly adminTokenProvider?: () => Promise<string | undefined>;
  private readonly adminGet: AdminGet;

  constructor(client: Client, appId: string, dataDir = join(process.cwd(), "data", "users"), options?: LarkCliOptions) {
    this.client = client;
    this.cacheFilePath = join(dataDir, `${appId}_users.json`);
    this.adminTokenProvider = options?.adminTokenProvider;
    this.adminGet = options?.adminGet ?? defaultAdminGet;
  }

  /**
   * 查询用户资料，带缓存和过期机制。
   *
   * 通道顺序：
   * 1. 管理员身份——FEISHU_ADMIN 通过 /login 授权的 user_access_token 调用 contact API。
   *    数据范围 = 管理员的组织架构可见范围（管理员默认全组织可见），应用可见范围外的内部成员同样可查；
   * 2. 管理员查不到 → 该用户是跨租户外部用户（不在本组织通讯录）→ 用**群成员名单**（机器人身份）
   *    分页查找拿中文名（群名单必含消息发送者）。
   *
   * 缓存：成功档案 3 天；全部通道失败也落盘冷却档案（openId + 旧资料），冷却 1 天后自动重试，
   * 避免重复打接口（应对"刚入群名单未同步"等临时失败）。消费方自行判断空字段并做兜底展示（如 openId 直显）。
   */
  async getUserProfile(openId: string, chatId?: string): Promise<LarkUserProfile> {
    await this.loadCache();

    const now = new Date();

    // 检查缓存是否过期：仅成功档案会写入缓存（3 天）；旧版本遗留的空档案条目按 1 天重查
    const cached = this.cache[openId];
    if (cached) {
      const updatedAt = new Date(cached.updatedAt);
      const ageInDays = (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
      const expiryDays = isSparseProfile(cached) ? SPARSE_CACHE_EXPIRY_DAYS : CACHE_EXPIRY_DAYS;
      if (ageInDays < expiryDays) {
        return cached;
      }
      logger.info(`[LarkCli] 用户 ${openId} 缓存已过期（${ageInDays.toFixed(1)} 天），重新查询`);
    }

    let resolved: ProfileName | undefined = await this.queryNameByAdmin(openId);
    let via = "管理员";

    // 管理员通道未命中 → 跨租户外部用户（不在本组织通讯录）→ 群成员名单（机器人身份）拿中文名
    if (!resolved && chatId) {
      resolved = await this.queryNameByGroupMembers(openId, chatId);
      if (resolved) via = "群名单";
    }

    // 全部通道失败：仍把 openId 落盘（保留旧资料），进入 1 天冷却——
    // 期间直接命中缓存不重复打接口，冷却期满自动重试（应对"刚入群名单未同步"等临时失败）
    if (!resolved) {
      const prev = this.cache[openId];
      const profile: LarkUserProfile = {
        openId,
        name: prev?.name,
        englishName: prev?.englishName,
        departmentNames: prev?.departmentNames,
        updatedAt: now.toISOString(),
      };
      this.cache[openId] = profile;
      await this.saveCache();
      logger.warn(`[LarkCli] 用户 ${openId} 所有通道未命中，写入冷却档案（1 天后重试）`);
      return profile;
    }

    const profile: LarkUserProfile = {
      openId,
      name: resolved.name,
      englishName: resolved.englishName,
      departmentNames: resolved.departmentNames,
      updatedAt: now.toISOString(),
    };

    // 更新缓存并保存
    this.cache[openId] = profile;
    await this.saveCache();

    // 【重要】每次新用户入库都打印
    const displayName = profile.name || profile.englishName || profile.openId;
    const englishInfo = profile.englishName ? `, 英文名: ${profile.englishName}` : "";
    const deptInfo = profile.departmentNames?.length ? `, 部门: ${profile.departmentNames.join(" / ")}` : "";
    logger.info(`[LarkCli] 🆕 新用户入库[${via}]: ${displayName} (${profile.openId})${englishInfo}${deptInfo}`);

    return profile;
  }

  /**
   * 管理员通道：以 FEISHU_ADMIN 的 user token（/login 获得）直查 contact v3，
   * 拿中文名/英文名/部门名——覆盖机器人应用身份查不到的用户（可用范围外的外部成员）。
   * 管理员未登录或查询失败返回 undefined（调用方保留已有结果）。部门名需二次调用部门接口换取。
   */
  private async queryNameByAdmin(openId: string): Promise<ProfileName | undefined> {
    const getToken = this.adminTokenProvider;
    if (!getToken) return undefined;
    try {
      const token = await getToken();
      if (!token) {
        logger.info("[LarkCli] 管理员通道未登录（/login 后可用），跳过");
        return undefined;
      }

      const userRes = await this.adminGet(`/open-apis/contact/v3/users/${openId}?user_id_type=open_id`, token);
      const user = userRes.user as { name?: string; en_name?: string; department_ids?: string[] } | undefined;
      if (!user && !userRes.name) {
        logger.warn(`[LarkCli] 管理员通道未查到用户 ${openId}`);
        return undefined;
      }

      const name = (user?.name || (userRes.name as string | undefined)) ?? undefined;
      const englishName = user?.en_name || undefined;
      const departmentIds = Array.isArray(user?.department_ids) ? user.department_ids : [];

      let departmentNames: string[] | undefined;
      if (departmentIds.length > 0) {
        const query = encodeURIComponent(departmentIds.join(","));
        const deptRes = await this.adminGet(`/open-apis/contact/v3/departments/batch?department_ids=${query}&user_id_type=open_id`, token);
        const items = Array.isArray(deptRes.items) ? (deptRes.items as Array<{ name?: string }>) : [];
        const names = items.map((d) => d.name).filter((n): n is string => Boolean(n));
        if (names.length > 0) departmentNames = names;
      }

      logger.info(`[LarkCli] 管理员通道查询成功: 中文名=${name}, 英文名=${englishName ?? "无"}, 部门=${departmentNames?.join(" / ") ?? "无"}`);
      return { name, englishName, departmentNames };
    } catch (error) {
      logger.warn(`[LarkCli] 管理员通道查询 ${openId} 失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** 加载缓存文件 */
  private async loadCache(): Promise<void> {
    if (this.cacheLoaded) return;
    try {
      await access(this.cacheFilePath, constants.R_OK);
      const content = await readFile(this.cacheFilePath, "utf8");
      this.cache = JSON.parse(content) as UserProfileCache;
    } catch {
      // 文件不存在或读取失败，使用空缓存
      this.cache = {};
    }
    this.cacheLoaded = true;
  }

  /** 保存缓存到文件 */
  private async saveCache(): Promise<void> {
    await mkdir(dirname(this.cacheFilePath), { recursive: true });
    await writeFile(this.cacheFilePath, `${JSON.stringify(this.cache, null, 2)}\n`, "utf8");
  }

  /** 外部用户兜底通道：分页遍历群成员名单查中文名（含跨租户外部成员；失败返回 undefined）。 */
  private async queryNameByGroupMembers(openId: string, chatId?: string): Promise<ProfileName | undefined> {
    if (!chatId) {
      logger.warn("[LarkCli] 无 chatId，无法从群成员列表查询");
      return undefined;
    }
    try {
      let pageToken: string | undefined;
      do {
        const res = await this.client.im.chatMembers.get({
          path: { chat_id: chatId },
          params: {
            member_id_type: "open_id",
            page_size: 100,
            page_token: pageToken,
          },
        });
        const member = (res.data?.items ?? []).find((m) => m.member_id === openId);
        if (member?.name) {
          logger.info(`[LarkCli] 从群 ${chatId} 成员列表获取到名字: ${member.name}`);
          return { name: member.name };
        }
        pageToken = res.data?.page_token;
      } while (pageToken);
      logger.warn(`[LarkCli] 群 ${chatId} 成员列表中未找到 ${openId}`);
      return undefined;
    } catch (error) {
      logger.warn(`[LarkCli] 从群成员列表查询失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
}
