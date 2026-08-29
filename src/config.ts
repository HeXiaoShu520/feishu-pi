export interface FeishuPiAppConfig {
  feishuAppId: string;
  feishuAppSecret: string;
  feishuBotOpenId?: string;
  cwd: string;
  sessionDir: string;
  modelProvider: string;
  modelId: string;
  modelBaseUrl?: string;
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
    cwd: env.FEISHU_PI_CWD ?? process.cwd(),
    sessionDir: env.FEISHU_PI_SESSION_DIR ?? `${process.cwd()}/data/sessions`,
    modelProvider: env.FEISHU_PI_MODEL_PROVIDER ?? "anthropic",
    modelId: env.FEISHU_PI_MODEL_ID ?? "claude-sonnet-4-6",
    modelBaseUrl: env.FEISHU_PI_MODEL_BASE_URL,
  };
}
