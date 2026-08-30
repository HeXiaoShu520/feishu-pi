/**
 * 管理员身份解析器
 * 将管理员标识（Open ID / 姓名 / 邮箱）转换为 Open ID
 */
import { Client } from "@larksuiteoapi/node-sdk";
import { logger } from "../utils/logger.ts";

/**
 * 解析管理员标识为 Open ID
 * @param client 飞书 Client
 * @param identifier 管理员标识（Open ID / 姓名 / 邮箱）
 * @returns Open ID，解析失败返回 undefined
 */
export async function resolveAdminOpenId(client: Client, identifier: string | undefined): Promise<string | undefined> {
  // 如果没有配置管理员，返回 undefined
  if (!identifier) {
    return undefined;
  }

  // 如果已经是 Open ID 格式（ou_开头），直接返回
  if (identifier.startsWith("ou_")) {
    return identifier;
  }

  // 尝试通过邮箱查找
  if (identifier.includes("@")) {
    try {
      const res = await client.contact.user.batchGetId({
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
