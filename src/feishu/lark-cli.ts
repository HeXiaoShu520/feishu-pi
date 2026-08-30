import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { logger } from "../utils/logger.ts";

export interface LarkUserProfile {
  openId: string;
  name?: string;           // 中文名
  englishName?: string;    // 英文名
  departmentNames?: string[]; // 部门中文名列表（通过 lark-cli 搜索获取）
  /** 信息查询或更新时间（ISO 8601） */
  updatedAt: string;
}

export type LarkCliStatus = "ready" | "missing" | "not_authenticated";

const CACHE_EXPIRY_DAYS = 3;

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

  constructor(client: Client, appId: string, dataDir = join(process.cwd(), "data", "users")) {
    this.client = client;
    this.cacheFilePath = join(dataDir, `${appId}_users.json`);
  }

  /**
   * 查询用户资料，带缓存和过期机制。
   *
   * 查询策略：
   * 1. 应用成员：API 获取中文名、英文名、邮箱
   * 2. 群聊成员：群成员列表获取中文名
   * 3. 统一使用 lark-cli 搜索获取部门中文名
   */
  async getUserProfile(openId: string, chatId?: string): Promise<LarkUserProfile> {
    await this.loadCache();

    const now = new Date();

    // 检查缓存是否过期（超过 3 天）
    const cached = this.cache[openId];
    if (cached) {
      const updatedAt = new Date(cached.updatedAt);
      const ageInDays = (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (ageInDays < CACHE_EXPIRY_DAYS) {
        return cached;
      }
      logger.info(`[LarkCli] 用户 ${openId} 缓存已过期（${ageInDays.toFixed(1)} 天），重新查询`);
    }

    let name: string | undefined;
    let englishName: string | undefined;
    let searchName: string | undefined; // 用于 lark-cli 搜索的名字

    // 第一步：尝试使用机器人 API 查询（应用成员）
    try {
      const res = await this.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: "open_id" },
      });

      if (res.data?.user) {
        const user = res.data.user;
        name = user.name || undefined;
        englishName = user.en_name || undefined;
        searchName = englishName || name; // 优先用英文名搜索
        logger.info(`[LarkCli] API 查询成功: 中文名=${name}, 英文名=${englishName}`);
      } else {
        throw new Error("API 返回的用户资料为空");
      }
    } catch (apiError) {
      // 第二步：API 查询失败，尝试从群成员列表获取（非应用成员）
      logger.warn(`[LarkCli] API 查询用户 ${openId} 失败：${apiError instanceof Error ? apiError.message : String(apiError)}`);

      if (!chatId) {
        logger.warn(`[LarkCli] 无 chatId，无法从群成员列表查询`);
        return this.createFallbackProfile(openId, now);
      }

      try {
        logger.info(`[LarkCli] 尝试从群 ${chatId} 成员列表获取用户信息`);

        // 分页获取群成员列表
        let pageToken: string | undefined;
        let member: any;

        do {
          const chatMemberRes = await this.client.im.chatMembers.get({
            path: { chat_id: chatId },
            params: {
              member_id_type: "open_id",
              page_size: 100,
              page_token: pageToken,
            },
          });

          member = chatMemberRes.data?.items?.find((m) => m.member_id === openId);

          if (member) break;

          pageToken = chatMemberRes.data?.page_token;
        } while (pageToken);

        if (!member || !member.name) {
          throw new Error("群成员列表中未找到该用户或无名字");
        }

        name = member.name;
        searchName = name; // 用中文名搜索
        logger.info(`[LarkCli] 从群成员列表获取到名字: ${name}`);
      } catch (chatError) {
        logger.warn(`[LarkCli] 从群成员列表查询失败：${chatError instanceof Error ? chatError.message : String(chatError)}`);
        return this.createFallbackProfile(openId, now);
      }
    }

    // 第三步：使用 lark-cli 搜索用户，获取部门中文名（群成员还需补充英文名）
    let departmentNames: string[] | undefined;
    if (searchName) {
      const larkResult = await this.getDepartmentNames(openId, searchName);
      departmentNames = larkResult.departmentNames;
      // 如果是群成员（没有英文名），从 lark-cli 补充
      if (!englishName && larkResult.englishName) {
        englishName = larkResult.englishName;
        logger.info(`[LarkCli] 群成员补充英文名: ${englishName}`);
      }
    }

    const profile: LarkUserProfile = {
      openId,
      name,
      englishName,
      departmentNames,
      updatedAt: now.toISOString(),
    };

    // 更新缓存并保存
    this.cache[openId] = profile;
    await this.saveCache();

    // 【重要】每次新用户入库都打印
    const displayName = profile.name || profile.englishName || profile.openId;
    const deptInfo = profile.departmentNames && profile.departmentNames.length > 0
      ? profile.departmentNames.join(", ")
      : "无";
    const englishInfo = profile.englishName ? `, 英文名: ${profile.englishName}` : "";
    logger.info(`[LarkCli] 🆕 新用户入库: ${displayName} (${profile.openId})${englishInfo}, 部门: ${deptInfo}`);

    return profile;
  }

  /** 通过 lark-cli 搜索用户，获取部门中文名和英文名 */
  private async getDepartmentNames(openId: string, searchName: string): Promise<{ departmentNames?: string[]; englishName?: string }> {
    try {
      const { spawn } = await import("node:child_process");
      const result = await new Promise<string>((resolve, reject) => {
        const child = spawn("lark-cli", ["contact", "+search-user", "--query", searchName, "--as", "user"], { shell: true, windowsHide: true });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => { stdout += data; });
        child.stderr.on("data", (data) => { stderr += data; });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve(stdout);
          else reject(new Error(`lark-cli 搜索失败: ${stderr}`));
        });
      });

      const searchResult = JSON.parse(result);
      const user = searchResult.data?.users?.find((u: any) => u.open_id === openId);

      if (!user) {
        logger.warn(`[LarkCli] lark-cli 搜索结果中未找到 ${openId}`);
        return {};
      }

      const resultData: { departmentNames?: string[]; englishName?: string } = {};

      // 提取部门信息
      const department = user.department;
      if (department && department.trim()) {
        logger.info(`[LarkCli] 通过 lark-cli 获取到部门: ${department}`);
        resultData.departmentNames = [department];
      } else {
        logger.info(`[LarkCli] lark-cli 搜索结果中无部门信息`);
      }

      // 提取英文名（用于群成员补充）
      const email = user.email || user.enterprise_email;
      if (email) {
        const englishName = email.split("@")[0]; // 从邮箱提取英文名
        logger.info(`[LarkCli] 通过 lark-cli 获取到邮箱/英文名: ${englishName}`);
        resultData.englishName = englishName;
      }

      return resultData;
    } catch (error) {
      logger.warn(`[LarkCli] lark-cli 搜索失败：${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  }

  /** 检查 CLI 是否存在以及是否有可用身份（废弃，保留兼容性） */
  async status(): Promise<LarkCliStatus> {
    return "ready";
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
    await mkdir(join(this.cacheFilePath, ".."), { recursive: true });
    await writeFile(this.cacheFilePath, `${JSON.stringify(this.cache, null, 2)}\n`, "utf8");
  }

  /** 返回面向用户的 CLI 状态提示（废弃，保留兼容性） */
  statusMessage(status: LarkCliStatus): string {
    return "飞书 SDK 已就绪。";
  }

  /** 创建降级的用户资料（最小信息） */
  private createFallbackProfile(openId: string, now: Date): LarkUserProfile {
    return {
      openId,
      name: undefined,
      englishName: undefined,
      departmentNames: undefined,
      updatedAt: now.toISOString(),
    };
  }
}
