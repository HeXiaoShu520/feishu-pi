import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../utils/logger.ts";

export interface LarkUserProfile {
  name: string;            // 中文名（查不到为空串）
  en_name: string;     // 英文名（查不到为空串）
  department_name: string[]; // 部门路径（查不到为空数组；来自 lark-cli 用户态搜索）
  /** 信息查询或更新时间（ISO 8601） */
  updatedAt: string;
}

/** 单次查询通道的返回：命中的资料字段 */
export interface ProfileName {
  name?: string;
  en_name?: string;
  department_name?: string[];
}

export interface LarkCliOptions {
  /**
   * lark-cli 用户态搜索通道（contact +search-user）：唯一的资料查询来源。
   * 用已 /login 用户的 token 按 open_id 反查姓名与现成中文部门路径，
   * 不依赖任何需审核的通讯录权限（见 lark-cli-search.ts）。
   */
  searchUser?: (openId: string) => Promise<ProfileName | undefined>;
}

const CACHE_EXPIRY_DAYS = 3;
/** 空档案（搜索未命中的最小资料）的重查间隔：信息可能随时变得可查，更快重试 */
const SPARSE_CACHE_EXPIRY_DAYS = 1;

/** 空档案判定：无名字、无英文名、无部门（仅 openId） */
function isSparseProfile(profile: LarkUserProfile): boolean {
  return !profile.name && !profile.en_name && !profile.department_name?.length;
}

/** 所有用户资料的缓存结构（以 openId 为键） */
interface UserProfileCache {
  [openId: string]: LarkUserProfile;
}

/** 用户信息查询和缓存管理（唯一查询通道 = lark-cli 用户态搜索） */
export class LarkCli {
  private readonly cacheFilePath: string;
  private cache: UserProfileCache = {};
  private cacheLoaded = false;
  private readonly searchUser?: (openId: string) => Promise<ProfileName | undefined>;
  /** 同一用户的并发查询合并（如多条消息同时 @ 同一新人）：共享同一条查询链路 */
  private readonly inflight = new Map<string, Promise<LarkUserProfile>>();

  constructor(appId: string, dataDir = join(process.cwd(), "data", "users"), options?: LarkCliOptions) {
    this.cacheFilePath = join(dataDir, `${appId}_users.json`);
    this.searchUser = options?.searchUser;
  }

  /**
   * 查询用户资料，带缓存和过期机制。
   * 唯一通道：lark-cli 用户态搜索（需要目标本人或管理员已 /login；token 优先级见
   * createCliSearchUser）。未命中也落盘冷却档案（1 天后自动重试），避免重复打 CLI；
   * 消费方自行判断空字段并做兜底展示（如 openId 直显）。
   */
  async getUserProfile(openId: string, queryOptions?: { prefetch?: boolean }): Promise<LarkUserProfile> {
    await this.loadCache();

    // 检查缓存是否过期：成功档案 3 天；空档案按 1 天重查
    const cached = this.cache[openId];
    if (cached) {
      const updatedAt = new Date(cached.updatedAt);
      const ageInDays = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
      const expiryDays = isSparseProfile(cached) ? SPARSE_CACHE_EXPIRY_DAYS : CACHE_EXPIRY_DAYS;
      if (ageInDays < expiryDays) {
        return cached;
      }
      logger.info(`[LarkCli] 用户 ${openId} 缓存已过期（${ageInDays.toFixed(1)} 天），重新查询`);
    }

    const inflight = this.inflight.get(openId);
    if (inflight) return inflight;
    const task = this.queryAndCache(openId).finally(() => {
      this.inflight.delete(openId);
    });
    this.inflight.set(openId, task);
    return task;
  }

  /** 实际查询 + 缓存写入（经 getUserProfile 的 inflight 合并进入，同一用户串行）。 */
  private async queryAndCache(openId: string): Promise<LarkUserProfile> {
    let resolved: ProfileName | undefined;
    if (this.searchUser) {
      try {
        resolved = await this.searchUser(openId);
      } catch (error) {
        logger.warn(`[LarkCli] 用户态搜索通道失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const prev = this.cache[openId];
    const profile: LarkUserProfile = {
      name: resolved?.name ?? prev?.name ?? "",
      en_name: resolved?.en_name ?? prev?.en_name ?? "",
      department_name: resolved?.department_name ?? prev?.department_name ?? [],
      updatedAt: new Date().toISOString(),
    };

    // 无论命中与否都落盘：命中为成功档案（3 天）；未命中的空档案按 1 天冷却重试
    this.cache[openId] = profile;
    await this.saveCache();

    if (resolved) {
      const displayName = profile.name || profile.en_name;
      const englishInfo = profile.en_name ? `, 英文名: ${profile.en_name}` : "";
      const deptInfo = profile.department_name?.length ? `, 部门: ${profile.department_name.join(" / ")}` : "";
      logger.info(`[LarkCli] 🆕 新用户入库[搜索]: ${displayName}${englishInfo}${deptInfo}`);
    } else {
      logger.info(`[LarkCli] 用户 ${openId} 搜索未命中，写入冷却档案（1 天后重试）`);
    }
    return profile;
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

  /**
   * 团队名单入库（启动第 3 步，仅 openId + 姓名，部门留空——部门在该成员实际
   * 互动/被检索时经 search-user 补全）。已有资料的字段一律保留，只补缺失的姓名。
   * 返回新增入库人数。
   */
  async upsertRosterNames(entries: Array<{ openId: string; name?: string }>): Promise<number> {
    await this.loadCache();
    let added = 0;
    for (const entry of entries) {
      if (!entry.openId || !entry.name) continue;
      const prev = this.cache[entry.openId];
      if (prev?.name) continue; // 已有姓名：保留原资料
      this.cache[entry.openId] = {
        name: entry.name,
        en_name: prev?.en_name ?? "",
        department_name: prev?.department_name ?? [],
        updatedAt: new Date().toISOString(),
      };
      added++;
    }
    if (added > 0) await this.saveCache();
    if (added > 0) logger.info(`[LarkCli] 团队名单入库 ${added} 人（仅姓名，部门待补全）`);
    return added;
  }
}
