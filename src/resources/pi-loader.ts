import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { relative, resolve, isAbsolute } from "node:path";
import { logger } from "../utils/logger.ts";
import { resourceEnabled, type ResourceConfig } from "./config.ts";

/** Pi owns discovery and prompt construction; this adapter only selects resources. */
export async function createProjectResourceLoader(
  cwd: string,
  config: ResourceConfig,
): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: resolve(cwd, ".agent"),
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
    agentsFilesOverride: ({ agentsFiles }) => ({
      agentsFiles: agentsFiles.filter((file) => {
        const path = relative(resolve(cwd), resolve(file.path));
        const allowed =
          path !== ".." &&
          !path.startsWith("..\\") &&
          !path.startsWith("../") &&
          !isAbsolute(path);
        if (!allowed)
          logger.warn(`[Resources] 已忽略工程外的项目上下文文件: ${file.path}`);
        return allowed;
      }),
    }),
  });
  await loader.reload();
  for (const diagnostic of loader.getSkills().diagnostics)
    logger.warn(`[Resources] Skill ${diagnostic.path}: ${diagnostic.message}`);
  return loader;
}
