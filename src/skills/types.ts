import type { FeishuContext } from "../context/types.ts";
import type { FeishuPiTool } from "../runtime/types.ts";

/** 外部技能分支。 */
export interface SkillBranch {
  id: string;
  matches(context: FeishuContext): boolean;
  tools?: FeishuPiTool[];
  systemPrompt?: string;
}

/** 外部技能定义，由应用层加载并注入。 */
export interface FeishuSkill {
  id: string;
  description: string;
  branches: SkillBranch[];
}
