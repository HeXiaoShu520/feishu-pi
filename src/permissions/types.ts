import type { FeishuContext } from "../context/types.ts";

/** 描述一个技能可使用的工具集合。 */
export interface SkillPermission {
  skillId: string;
  toolNames: string[];
}

/** 按用户和部门决定技能与工具权限。 */
export interface PermissionPolicy {
  isAdmin(context: FeishuContext): boolean;
  allowedTools(context: FeishuContext, skillId?: string): string[];
}
