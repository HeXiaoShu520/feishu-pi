export interface FeishuPiAppConfig {
  feishuAppId: string;
  feishuAppSecret: string;
  feishuAdmin: string;
  feishuTeamMembers: string[];
  cwd: string;
  sessionDir: string;
  modelProvider: string;
  modelName: string;
  modelBaseUrl?: string;
  systemPrompt?: string;
  /** 工具调用白名单（正则，命中即放行，不弹卡） */
  cmdWhitelist: string[];
  /** 是否启用大模型 Guard 审核层 */
  guardEnabled: boolean;
  /** Guard 审核接口（OpenAI 兼容）；未配置则不启用大模型审核，风险调用直接弹卡 */
  guardBaseUrl?: string;
  /** Guard 模型列表（多个时全部 allow 才放行，任一 ask 即弹卡） */
  guardModels: string[];
  /** 未配置时回退主模型 Key */
  guardApiKey?: string;
  guardTimeoutMs: number;
  /** 授权卡片等待管理员点击的超时时间（超时视为拒绝） */
  approvalTimeoutMs: number;
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
    feishuAdmin: env.FEISHU_ADMIN || "", // 可选：支持中文名、英文名、open_id、邮箱
    feishuTeamMembers: env.FEISHU_TEAM_MEMBERS ? env.FEISHU_TEAM_MEMBERS.split(",").map((m) => m.trim()) : [],
    cwd: env.FEISHU_PI_CWD ?? process.cwd(),
    sessionDir: `${process.cwd()}/data/sessions`,
    modelProvider: env.FEISHU_PI_MODEL_PROVIDER ?? "anthropic",
    modelName: env.FEISHU_PI_MODEL_NAME ?? "claude-sonnet-4-6",
    modelBaseUrl: env.FEISHU_PI_MODEL_BASE_URL,
    systemPrompt: env.FEISHU_PI_SYSTEM_PROMPT,
    // 白名单按行或分号分隔，每项是一个正则
    cmdWhitelist: (env.FEISHU_CMD_WHITELIST ?? "").split(/\n|;/).map((s) => s.trim()).filter(Boolean),
    guardEnabled: env.FEISHU_GUARD_ENABLED !== "false",
    // 空 = 不启用大模型审核（不再回退主模型，避免审核花主模型的钱）
    guardBaseUrl: env.FEISHU_GUARD_BASE_URL || undefined,
    // 支持逗号分隔多个 Guard 模型，取"安全交集"：全部 allow 才放行
    guardModels: (env.FEISHU_GUARD_MODELS ?? env.FEISHU_GUARD_MODEL ?? "").split(",").map((m) => m.trim()).filter(Boolean),
    guardApiKey: env.FEISHU_GUARD_API_KEY ?? env.FEISHU_PI_MODEL_API_KEY,
    guardTimeoutMs: Number(env.FEISHU_GUARD_TIMEOUT_MS) > 0 ? Number(env.FEISHU_GUARD_TIMEOUT_MS) : 15_000,
    approvalTimeoutMs: Number(env.FEISHU_APPROVAL_TIMEOUT_MS) > 0 ? Number(env.FEISHU_APPROVAL_TIMEOUT_MS) : 5 * 60_000,
  };
}
