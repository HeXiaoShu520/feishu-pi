import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { logger } from "../utils/logger.ts";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export interface LarkUserProfile {
  name: string;            // 中文名（查不到为空串）
  en_name: string;     // 英文名（查不到为空串）
  department_name: string[]; // 部门名列表（查不到为空数组；需管理员开通部门权限后经管理员通道获取）
  /** 信息查询或更新时间（ISO 8601） */
  updatedAt: string;
}

/** 单次查询通道的返回：命中的资料字段（各通道按能力尽量填充） */
export interface ProfileName {
  name?: string;
  en_name?: string;
  department_name?: string[];
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
  /**
   * lark-cli 用户态搜索通道（contact +search-user）：用已 /login 用户的 token 按 open_id
   * 反查姓名与现成中文部门路径，不依赖需审核的部门权限。作为兜底补全通道在最后调用，
   * 只填前面通道缺失的字段（见 lark-cli-search.ts）。
   */
  searchUser?: (openId: string) => Promise<ProfileName | undefined>;
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

/** getUserProfile 的可选行为开关 */
export interface UserProfileQueryOptions {
  /**
   * 预取模式（上电时主动拉取管理员资料用）：全部通道失败时**不写冷却档案**。
   * 上电时管理员 user token 未登录、群名单也不可得，若按常规语义会把空档案冻住 1 天，
   * 导致真实首条消息命中冷却缓存而查不到资料。
   */
  prefetch?: boolean;
}

/** 空档案判定：无名字、无英文名、无部门（仅 openId） */
function isSparseProfile(profile: LarkUserProfile): boolean {
  return !profile.name && !profile.en_name && !profile.department_name?.length;
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
  private readonly searchUser?: (openId: string) => Promise<ProfileName | undefined>;

  constructor(client: Client, appId: string, dataDir = join(process.cwd(), "data", "users"), options?: LarkCliOptions) {
    this.client = client;
    this.cacheFilePath = join(dataDir, `${appId}_users.json`);
    this.adminTokenProvider = options?.adminTokenProvider;
    this.adminGet = options?.adminGet ?? defaultAdminGet;
    this.searchUser = options?.searchUser;
  }

  /**
   * 查询用户资料，带缓存和过期机制。
   *
   * 通道顺序（部分合并：后一通道只补前一通道缺失的字段，凑齐"姓名+部门"即止）：
   * 1. 管理员用户身份——FEISHU_ADMIN 通过 /login 授权的 user_access_token 调用 contact API；
   *    数据范围 = 管理员的组织架构可见范围。姓名通常可得，部门字段常因需审核权限而缺失；
   * 2. 机器人身份——tenant token 直查 contact v3。姓名通常可得（应用可见范围内），部门同样常缺；
   * 3. 群成员名单（机器人身份）——前两通道都查不到时（如跨租户外部用户），分页拉群名单拿显示名；
   * 4. lark-cli 用户态搜索（contact +search-user）——用已 /login 用户（目标本人优先，其次管理员）
   *    的 token 按 open_id 反查：姓名 + 现成中文部门路径，**不依赖需审核的部门权限**。
   *    这是部门信息的主要来源。
   *
   * 缓存：成功档案 3 天；全部通道失败也落盘冷却档案（openId + 旧资料），冷却 1 天后自动重试，
   * 避免重复打接口（应对"刚入群名单未同步"等临时失败）。消费方自行判断空字段并做兜底展示（如 openId 直显）。
   * prefetch 模式例外：失败不落冷却档案（见 UserProfileQueryOptions）。
   */
  /** 同一用户的并发查询合并（如多条消息同时 @ 同一新人）：共享同一条查询链路 */
  private readonly inflight = new Map<string, Promise<LarkUserProfile>>();

  async getUserProfile(openId: string, chatId?: string, queryOptions?: UserProfileQueryOptions): Promise<LarkUserProfile> {
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

    const inflight = this.inflight.get(openId);
    if (inflight) return inflight;
    const task = this.queryAndCache(openId, chatId, queryOptions).finally(() => {
      this.inflight.delete(openId);
    });
    this.inflight.set(openId, task);
    return task;
  }

  /** 实际查询 + 缓存写入（经 getUserProfile 的 inflight 合并进入，同一用户串行）。 */
  private async queryAndCache(openId: string, chatId?: string, queryOptions?: UserProfileQueryOptions): Promise<LarkUserProfile> {
    const now = new Date();
    // 部分合并：姓名 + 部门凑齐即提前收工；via 记录有贡献的通道（日志用）
    const resolved: ProfileName = {};
    const via: string[] = [];
    const complete = (): boolean => Boolean(resolved.name && resolved.department_name?.length);
    const merge = (partial: ProfileName | undefined, tag: string): void => {
      if (!partial) return;
      let contributed = false;
      if (!resolved.name && partial.name) {
        resolved.name = partial.name;
        contributed = true;
      }
      if (!resolved.en_name && partial.en_name) {
        resolved.en_name = partial.en_name;
        contributed = true;
      }
      if (!resolved.department_name?.length && partial.department_name?.length) {
        resolved.department_name = partial.department_name;
        contributed = true;
      }
      if (contributed) via.push(tag);
    };

    merge(await this.queryNameByAdmin(openId), "管理员");
    if (!complete()) merge(await this.queryNameByBot(openId), "机器人");
    if (!complete() && chatId) merge(await this.queryNameByGroupMembers(openId, chatId), "群名单");
    if (!complete() && this.searchUser) {
      try {
        merge(await this.searchUser(openId), "搜索");
      } catch (error) {
        logger.warn(`[LarkCli] 用户态搜索通道失败（不影响其他通道结果）：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 全部通道失败：常规语义落冷却档案（1 天）；预取模式不落盘，避免冻住真实首条消息的查询
    if (!via.length) {
      if (queryOptions?.prefetch) {
        logger.info(`[LarkCli] 预取 ${openId} 资料未命中（不落冷却档案），留待真实消息时再查`);
        const prev = this.cache[openId];
        return {
          name: prev?.name ?? "",
          en_name: prev?.en_name ?? "",
          department_name: prev?.department_name ?? [],
          updatedAt: now.toISOString(),
        };
      }
      const prev = this.cache[openId];
      const profile: LarkUserProfile = {
        name: prev?.name ?? "",
        en_name: prev?.en_name ?? "",
        department_name: prev?.department_name ?? [],
        updatedAt: now.toISOString(),
      };
      this.cache[openId] = profile;
      await this.saveCache();
      logger.warn(`[LarkCli] 用户 ${openId} 所有通道未命中，写入冷却档案（1 天后重试）`);
      return profile;
    }

    const profile: LarkUserProfile = {
      name: resolved.name ?? "",
      en_name: resolved.en_name ?? "",
      department_name: resolved.department_name ?? [],
      updatedAt: now.toISOString(),
    };

    // 更新缓存并保存
    this.cache[openId] = profile;
    await this.saveCache();

    // 【重要】每次新用户入库都打印（openId 即缓存键，不在内容/日志中重复）
    const displayName = profile.name || profile.en_name;
    const englishInfo = profile.en_name ? `, 英文名: ${profile.en_name}` : "";
    const deptInfo = profile.department_name?.length ? `, 部门: ${profile.department_name.join(" / ")}` : "";
    logger.info(`[LarkCli] 🆕 新用户入库[${via.join("+")}]: ${displayName}${englishInfo}${deptInfo}`);

    return profile;
  }

  /**
   * 管理员通道：以 FEISHU_ADMIN 的 user token（/login 获得）直查 contact v3，
   * 拿中文名/英文名。部门字段（department_path）普遍需要管理员审核的权限、常常拿不到，
   * 缺失不在此告警——部门由 lark-cli 用户态搜索通道兜底补全。
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
      const user = userRes.user as {
        name?: string;
        en_name?: string;
        /** user token 调用且权限齐备时返回：完整部门路径（多数租户未开通，缺失走搜索通道） */
        department_path?: Array<{ department_name?: { name?: string }; department_path?: { name?: string } }>;
      } | undefined;
      if (!user && !userRes.name) {
        const detail = str(userRes.msg) || str(userRes.error_description) || str(userRes.error) || "响应无 user 字段";
        logger.warn(`[LarkCli] 管理员通道未查到用户 ${openId}：${detail}`);
        return undefined;
      }

      const name = (user?.name || (userRes.name as string | undefined)) ?? undefined;
      const en_name = user?.en_name || undefined;

      // 部门名：department_path.name（完整路径）有则用，缺失留空（交给搜索通道补全）
      const department_name = Array.isArray(user?.department_path)
        ? user.department_path
            .map((d) => d.department_path?.name || d.department_name?.name)
            .filter((n): n is string => Boolean(n))
        : undefined;

      logger.info(`[LarkCli] 管理员通道查询成功: 中文名=${name}, 英文名=${en_name ?? "无"}, 部门=${department_name?.join(" / ") ?? "无"}`);
      return { name, en_name, department_name };
    } catch (error) {
      logger.warn(`[LarkCli] 管理员通道查询 ${openId} 失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * 机器人身份通道：tenant token 直查 contact v3（应用后台开通 contact 只读权限即可）。
   * 上电预取管理员资料不依赖任何用户 /login；查不到返回 undefined（如外部用户不在通讯录）。
   */
  private async queryNameByBot(openId: string): Promise<ProfileName | undefined> {
    try {
      const res = await this.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: "open_id" },
      });
      if (res.code !== 0) {
        logger.info(`[LarkCli] 机器人通道未查到用户 ${openId}：${res.msg ?? `code ${res.code}`}`);
        return undefined;
      }
      const user = res.data?.user as {
        name?: string;
        en_name?: string;
        /** 应用身份通常拿不到部门字段（需审核权限），缺失时部门交给搜索通道 */
        department_path?: Array<{ department_path?: { name?: string }; department_name?: { name?: string } }>;
      } | undefined;
      const name = user?.name ?? undefined;
      const en_name = user?.en_name ?? undefined;
      const department_name = Array.isArray(user?.department_path)
        ? user.department_path
            .map((d) => d.department_path?.name || d.department_name?.name)
            .filter((n): n is string => Boolean(n))
        : undefined;
      if (!name && !en_name) return undefined;
      logger.info(`[LarkCli] 机器人通道查询成功: 中文名=${name}, 英文名=${en_name ?? "无"}, 部门=${department_name?.join(" / ") ?? "无"}`);
      return { name, en_name, department_name };
    } catch (error) {
      logger.warn(`[LarkCli] 机器人通道查询 ${openId} 失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

/** 加载缓存文件 */
  private async loadCache(): Promise<void> {    if (this.cacheLoaded) return;
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
