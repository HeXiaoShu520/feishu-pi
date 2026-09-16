/**
 * 管理员身份解析器
 * 将管理员标识（Open ID / 姓名 / 邮箱）转换为 Open ID
 */
import { Client } from "@larksuiteoapi/node-sdk";
import { logger } from "../utils/logger.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * 解析管理员标识为 Open ID
 * @param client 飞书 Client
 * @param identifier 管理员标识（Open ID / 姓名 / 邮箱）
 * @param appId 飞书应用 ID（用于定位缓存文件）
 * @param dataDir 数据目录（默认 data/users）
 * @returns Open ID，解析失败返回 undefined
 */
export async function resolveAdminOpenId(
  client: Client,
  identifier: string | undefined,
  appId?: string,
  dataDir = join(process.cwd(), "data", "users")
): Promise<string | undefined> {
  // 如果没有配置管理员，返回 undefined
  if (!identifier) {
    return undefined;
  }

  // 如果已经是 Open ID 格式（ou_开头），直接返回
  if (identifier.startsWith("ou_")) {
    return identifier;
  }

  // 尝试从缓存中查找（按姓名或英文名）
  if (appId) {
    try {
      const cacheFilePath = join(dataDir, `${appId}_users.json`);
      const content = await readFile(cacheFilePath, "utf8");
      const cache = JSON.parse(content) as Record<string, { name?: string; en_name?: string }>;

      // 遍历缓存，匹配姓名或英文名
      for (const [openId, profile] of Object.entries(cache)) {
        const { name, en_name } = profile;
        if (name === identifier || en_name === identifier) {
          logger.info(`[AdminResolver] 从缓存解析 ${identifier} -> ${openId}`);
          return openId;
        }
      }
    } catch {
      // 缓存文件不存在或解析失败，继续使用 API 查询
    }
  }

  // 尝试通过邮箱查找
  if (identifier.includes("@")) {
    try {
      const res = await client.contact.user.batchGetId({
        params: { user_id_type: "open_id" },
        data: {
          emails: [identifier],
        },
      });
      if (res.code === 0 && res.data?.user_list?.[0]?.user_id) {
        const openId = res.data.user_list[0].user_id;
        logger.info(`[AdminResolver] 通过邮箱 ${identifier} 解析为 Open ID: ${openId}`);
        return openId;
      }
    } catch (err) {
      logger.warn(`[AdminResolver] 通过邮箱查找失败:`, err);
    }
  }

  // 尝试通过姓名搜索用户
  try {
    const res = await client.contact.user.list({
      params: {
        user_id_type: "open_id",
        page_size: 50,
      },
    });

    if (res.code === 0 && res.data?.items) {
      for (const user of res.data.items) {
        const name = user.name;
        const enName = user.en_name;
        if (name === identifier || enName === identifier) {
          const openId = user.open_id;
          logger.info(`[AdminResolver] 通过姓名 ${identifier} 解析为 Open ID: ${openId}`);
          return openId;
        }
      }
    }
  } catch (err) {
    logger.warn(`[AdminResolver] 通过姓名搜索失败:`, err);
  }

  logger.error(`[AdminResolver] 无法解析管理员标识: ${identifier}`);
  return undefined;
}

// ---------------------------------------------------------------------------
// 冷启动兜底：从已 /login 用户的登录身份中识别管理员
// ---------------------------------------------------------------------------

/** 把资料并入用户缓存文件（已有条目字段保留合并，供 admin 缓存通道 / 群组部门匹配等复用）。 */
export async function persistUserProfile(
  usersFile: string,
  openId: string,
  profile: { name?: string; en_name?: string; department_name?: string[] },
): Promise<void> {
  let cache: Record<string, { name?: string; en_name?: string; department_name?: string[]; updatedAt?: string }> = {};
  try {
    cache = JSON.parse(await readFile(usersFile, "utf8")) as typeof cache;
  } catch {
    // 文件不存在/损坏：从空缓存开始
  }
  cache[openId] = { ...cache[openId], ...profile, updatedAt: new Date().toISOString() };
  await mkdir(dirname(usersFile), { recursive: true });
  await writeFile(usersFile, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

/** 管理员识别所需的登录态最小接口（由 UserAuthService 实现；结构化类型便于测试注入） */
export interface LoginIdentitySource {
  listLoginUsers(): Promise<string[]>;
  getUserAccessToken(openId: string): Promise<string | undefined>;
  describeIdentity(accessToken: string): Promise<{ openId?: string; name?: string; en_name?: string; email?: string } | undefined>;
}

/**
 * 冷启动管理员识别：FEISHU_PI_ADMIN 按姓名/邮箱在通讯录侧解析不出时（用户缓存为空、
 * 通讯录权限未批/未发布版本），从**已 /login 用户**的登录身份中识别管理员——
 * 逐个取有效 access token 反查 identity，openId/姓名/英文名/邮箱与配置匹配即命中。
 *
 * 配套使用方式（与"管理员先 /login、再重启一遍"的运维流程一致）：
 * /login 完成时 onLoginBound 也会把匹配者的资料写入用户缓存；此后每次启动
 * 都能走缓存通道直接解析，不再依赖任何 token 或通讯录权限。
 */
export async function resolveAdminFromLogins(
  userAuth: LoginIdentitySource,
  identifier: string | undefined,
  usersFile: string,
): Promise<string | undefined> {
  if (!identifier) return undefined;

  let candidates: string[] = [];
  try {
    candidates = await userAuth.listLoginUsers();
  } catch {
    return undefined;
  }
  for (const openId of candidates) {
    const token = await userAuth.getUserAccessToken(openId).catch(() => undefined);
    if (!token) continue;
    const identity = await userAuth.describeIdentity(token).catch(() => undefined);
    if (!identity?.openId) continue;
    const matched =
      identity.openId === identifier ||
      identity.name === identifier ||
      identity.en_name === identifier ||
      (Boolean(identity.email) && identity.email === identifier);
    if (!matched) continue;

    logger.info(`[AdminResolver] 经已登录身份识别管理员：${identity.name ?? identity.openId} -> ${identity.openId}`);
    // 资料写入用户缓存：下次启动走缓存通道直接解析，无需再反查身份
    try {
      await persistUserProfile(usersFile, identity.openId, { name: identity.name, en_name: identity.en_name });
    } catch (error) {
      logger.warn("[AdminResolver] 管理员资料写入用户缓存失败（不影响本次识别）:", error);
    }
    return identity.openId;
  }
  return undefined;
}
