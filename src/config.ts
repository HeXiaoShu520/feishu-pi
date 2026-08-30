export interface FeishuPiAppConfig {
  feishuAppId: string;
  feishuAppSecret: string;
  feishuBotOpenId?: string;
  feishuAdmin: string;
  feishuTeamMembers: string[];
  cwd: string;
  sessionDir: string;
  modelProvider: string;
  modelName: string;
  modelBaseUrl?: string;
  systemPrompt?: string;
}

/** 从环境变量读取 feishu-pi 启动配置。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): FeishuPiAppConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };
  return {
    feishuAppId: required("FEISHU_APP_ID"),
    feishuAppSecret: required("FEISHU_APP_SECRET"),
    feishuBotOpenId: env.FEISHU_BOT_OPEN_ID,
    feishuAdmin: env.FEISHU_ADMIN || "", // 可选：支持中文名、英文名、open_id、邮箱
    feishuTeamMembers: env.FEISHU_TEAM_MEMBERS ? env.FEISHU_TEAM_MEMBERS.split(",").map((m) => m.trim()) : [],
    cwd: env.FEISHU_PI_CWD ?? process.cwd(),
    sessionDir: `${process.cwd()}/data/sessions`,
    modelProvider: env.FEISHU_PI_MODEL_PROVIDER ?? "anthropic",
    modelName: env.FEISHU_PI_MODEL_NAME ?? "claude-sonnet-4-6",
    modelBaseUrl: env.FEISHU_PI_MODEL_BASE_URL,
    systemPrompt: env.FEISHU_PI_SYSTEM_PROMPT,
  };
}
