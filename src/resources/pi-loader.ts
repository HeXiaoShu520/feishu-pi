import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { logger } from "../utils/logger.ts";
import { resourceEnabled, type ResourceConfig } from "./config.ts";

/** Pi owns discovery and prompt construction; this adapter only selects resources. */
export async function createProjectResourceLoader(
  cwd: string,
  config: ResourceConfig,
  appendSystemPrompt: string[] = [],
): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: resolve(cwd, ".agent"),
    // 按配置追加的系统提示（如「回复不要 emoji」）：pi 在 customPrompt 之外单列 <addendum> 段，
    // SYSTEM.md 仍是 preamble，两者不互相覆盖
    ...(appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {}),
    // Only explicit sources: Pi's default discovery also scans the user's global .agents/skills.
    noSkills: true,
    additionalSkillPaths: config.skills.enabled
      ? [resolve(cwd, ".agent", "skills"), ...config.skills.paths]
      : [],
    skillsOverride: ({ skills, diagnostics }) => ({
      skills: skills.filter((skill) =>
        resourceEnabled(config.skills, skill.name),
      ),
      diagnostics,
    }),
    // 工程文档（AGENTS.md / CLAUDE.md）是给开发工具看的，不进聊天模型的系统提示：
    // 否则模型每轮都看到目录结构、启动命令和权限约定，会把自己当工程 Agent 而不是聊天对象。
    // 人格与对话约束只由 .agent/SYSTEM.md 承载。
    agentsFilesOverride: ({ agentsFiles }) => {
      for (const file of agentsFiles) {
        logger.info(`[Resources] 已忽略项目上下文 ${file.path}（对话人格只由 .agent/SYSTEM.md 承载）`);
      }
      return { agentsFiles: [] };
    },
  });
  await loader.reload();
  for (const diagnostic of loader.getSkills().diagnostics)
    logger.warn(`[Resources] Skill ${diagnostic.path}: ${diagnostic.message}`);
  return loader;
}
