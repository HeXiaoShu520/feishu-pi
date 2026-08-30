import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";

export interface LarkUserProfile {
  openId: string;
  name?: string;           // 中文名
  englishName?: string;    // 英文名
  departmentIds: string[]; // 部门 ID 列表（如 "0" 表示根部门）
  departmentNames?: string[]; // 部门中文名列表（后续可查询填充）
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

  constructor(client: Client, appId: string, dataDir = join(process.cwd(), "memory", "users")) {
    this.client = client;
    this.cacheFilePath = join(dataDir, `${appId}_users.json`);
  }

  /**
   * 查询用户资料，带缓存和过期机制。
   * - 使用飞书 SDK 调用 API（使用工程机器人凭证）
   * - 使用 openId 作为缓存键
   * - 缓存有效期 3 天
   * - 如果 API 查询失败（非应用成员），尝试从群成员列表获取
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
      console.info(`[LarkCli] 用户 ${openId} 缓存已过期（${ageInDays.toFixed(1)} 天），重新查询`);
    }

    // 第一步：尝试使用机器人 API 查询完整信息
    try {
      const res = await this.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: "open_id" },
      });

      if (!res.data?.user) {
        throw new Error("API 返回的用户资料为空");
      }

      const user = res.data.user;
      if (!user.open_id) throw new Error("用户资料缺少 open_id");

      const profile = {
        openId: user.open_id,
        name: user.name || undefined,
        englishName: user.en_name || undefined,
        departmentIds: user.department_ids ?? [],
        departmentNames: undefined, // 后续可查询填充
        updatedAt: now.toISOString(),
      };

      // 更新缓存并保存
      this.cache[openId] = profile;
      await this.saveCache();

      // 打印新用户或更新信息
      const isNew = !cached;
      const displayName = profile.name || profile.englishName || profile.openId;
      if (isNew) {
        console.info(`[LarkCli] 新用户入库: ${displayName} (${profile.openId}), 部门ID: ${profile.departmentIds.length > 0 ? profile.departmentIds.join(", ") : "无"}`);
      } else {
        console.info(`[LarkCli] 更新用户: ${displayName} (${profile.openId})`);
      }

      return profile;
    } catch (apiError) {
      // 第二步：API 查询失败，尝试从群成员列表获取（非应用成员场景）
      console.warn(`[LarkCli] API 查询用户 ${openId} 失败：${apiError instanceof Error ? apiError.message : String(apiError)}`);

      if (!chatId) {
        console.warn(`[LarkCli] 无 chatId，无法从群成员列表查询`);
        return this.createFallbackProfile(openId, now);
      }

      try {
        console.info(`[LarkCli] 尝试从群 ${chatId} 成员列表获取用户信息`);

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

          if (member) break; // 找到了就退出循环

          pageToken = chatMemberRes.data?.page_token;
        } while (pageToken);

        if (!member || !member.name) {
          throw new Error("群成员列表中未找到该用户或无名字");
        }

        console.info(`[LarkCli] 从群成员列表获取到名字: ${member.name}`);

        // 第三步：使用 lark-cli 通过名字搜索用户，获取部门信息
        const profile = await this.searchUserByName(openId, member.name, now);
        return profile;
      } catch (chatError) {
        console.warn(`[LarkCli] 从群成员列表查询失败：${chatError instanceof Error ? chatError.message : String(chatError)}`);
        return this.createFallbackProfile(openId, now);
      }
    }
  }

  /** 通过英文名搜索用户（使用 lark-cli） */
  private async searchUserByName(openId: string, englishName: string, now: Date): Promise<LarkUserProfile> {
    try {
      const { spawn } = await import("node:child_process");
      const result = await new Promise<string>((resolve, reject) => {
        const child = spawn("lark-cli", ["contact", "+search-user", "--query", englishName, "--as", "user"], { shell: true, windowsHide: true });
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
        throw new Error("搜索结果中未找到匹配的用户");
      }

      // 从搜索结果中无法获取 department_ids，使用降级信息
      const profile: LarkUserProfile = {
        openId,
        name: user.localized_name || undefined,
        englishName,
        departmentIds: [], // 搜索结果中没有部门信息
        departmentNames: undefined,
        updatedAt: now.toISOString(),
      };

      console.info(`[LarkCli] 通过英文名搜索到用户: ${englishName} (${openId})`);
      return profile;
    } catch (error) {
      console.warn(`[LarkCli] lark-cli 搜索失败：${error instanceof Error ? error.message : String(error)}`);
      return this.createFallbackProfile(openId, now);
    }
  }

  /** 创建降级的用户资料（最小信息） */
  private createFallbackProfile(openId: string, now: Date): LarkUserProfile {
    return {
      openId,
      name: undefined,
      englishName: undefined,
      departmentIds: [],
      departmentNames: undefined,
      updatedAt: now.toISOString(),
    };
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
}
