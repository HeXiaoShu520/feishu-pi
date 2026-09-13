/** 飞书请求的统一上下文，所有技能都通过它获取调用者信息。
 *
 * 用户资料（姓名/英文名/部门）是**基础能力**：消息入口处已自动查询并注入，
 * 技能直接读这些字段即可，不需要（也无法）自行调用通讯录接口查询。 */
export interface FeishuContext {
  userOpenId: string;
  userName?: string;          // 展示名：中文名 > 英文名 > Open ID
  en_name?: string;           // 英文名（查不到为空）
  department_name?: string[]; // 部门名列表（查不到为空数组）
  chatId: string;
  threadId?: string;
  /** 会话模式：p2p 私聊 / group 普通群 / topic 话题群（传输层查询并缓存；查询失败按 group 兜底） */
  chatMode?: "p2p" | "group" | "topic";
  conversationId: string;
  isAdmin?: boolean; // 是否为管理员
}
