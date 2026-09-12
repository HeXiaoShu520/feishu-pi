/** 飞书请求的统一上下文，所有技能都通过它获取调用者信息。 */
export interface FeishuContext {
  userOpenId: string;
  userName?: string;
  departmentNames?: string[]; // 部门中文名列表
  chatId: string;
  threadId?: string;
  /** 会话模式：p2p 私聊 / group 普通群 / topic 话题群（传输层查询并缓存；查询失败按 group 兜底） */
  chatMode?: "p2p" | "group" | "topic";
  conversationId: string;
  isAdmin?: boolean; // 是否为管理员
}
