/** 飞书请求的统一上下文，所有技能都通过它获取调用者信息。 */
export interface FeishuContext {
  userOpenId: string;
  userName?: string;
  departmentNames?: string[]; // 部门中文名列表
  chatId: string;
  threadId?: string;
  conversationId: string;
  isAdmin?: boolean; // 是否为管理员
}
