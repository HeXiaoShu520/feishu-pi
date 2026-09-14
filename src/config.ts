export interface FeishuPiAppConfig {
  feishuAppId: string;
  feishuAppSecret: string;
  feishuAdmin: string;
  cwd: string;
  sessionDir: string;
  /** 数据根目录（data/，已被 .gitignore 排除），存放用户 token 等非会话数据 */
  dataDir: string;
  /** Per-user 授权（Device Flow，/login）申请的用户身份 scope；留空 = 禁用 /login */
  userAuthScopes: string[];
  modelProvider: string;
  modelName: string;
  modelBaseUrl?: string;
  systemPrompt?: string;
  /** 已废弃：原正则白名单环境变量。工具规则改用 .agent/permissions.json 的 permissions.allow */
  cmdWhitelist: string[];
  /** 智能体审核接口（OpenAI 兼容）；未配置则策略外调用直接弹卡 */
  guardBaseUrl?: string;
  /** 审核模型列表（多个时全部 allow 才放行，任一 ask 即弹卡） */
  guardModels: string[];
  /** 未配置时回退主模型 Key */
  guardApiKey?: string;
  guardTimeoutMs: number;
  /** 各组归属关系：组名 → 成员标识列表（从 FEISHU_GROUP_<NAME> 环境变量解析） */
  groupMembership: Record<string, string[]>;
  /** 授权卡片等待管理员点击的超时时间（超时视为拒绝） */
  approvalTimeoutMs: number;
  /** 回复卡末尾是否显示模型统计小字（模型 · token · ctx · 费用 · 耗时 · 会话别名）；工具过程状态不受影响 */
  showModelStats: boolean;
}

/** 布尔环境变量：未配置取 fallback；显式 1/true/on/yes 视为开，其余视为关。 */
function parseBoolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "on", "yes"].includes(value.trim().toLowerCase());
}

/** 从环境变量读取 feishu-pi 启动配置。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): FeishuPiAppConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };
  // 用户身份授权（Device Flow）默认 scope：用户资料查询所需的最小集合
  const parsedUserAuthScopes = (env.FEISHU_USER_AUTH_SCOPES ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

  return {
    feishuAppId: required("FEISHU_APP_ID"),
    feishuAppSecret: required("FEISHU_APP_SECRET"),
    feishuAdmin: env.FEISHU_ADMIN || "", // 可选：支持中文名、英文名、open_id、邮箱
    cwd: env.FEISHU_PI_CWD ?? process.cwd(),
    sessionDir: `${process.cwd()}/data/sessions`,
    dataDir: `${process.cwd()}/data`,
    // 用户身份授权 scope（Device Flow）：默认内置"用户资料查询"所需最小集合；FEISHU_USER_AUTH_SCOPES 可覆盖
    userAuthScopes: parsedUserAuthScopes.length > 0 ? parsedUserAuthScopes : ["contact:contact.base:readonly", "contact:user.base:readonly", "contact:user.department:readonly", "contact:user.department_path:readonly", "contact:department.base:readonly"],
    modelProvider: env.FEISHU_PI_MODEL_PROVIDER ?? "anthropic",
    modelName: env.FEISHU_PI_MODEL_NAME ?? "claude-sonnet-4-6",
    modelBaseUrl: env.FEISHU_PI_MODEL_BASE_URL,
    systemPrompt: env.FEISHU_PI_SYSTEM_PROMPT,
    // 已废弃：保留解析仅为启动时给出弃用提示；规则请配置在 .agent/permissions.json
    cmdWhitelist: (env.FEISHU_CMD_WHITELIST ?? "").split(/\n|;/).map((s) => s.trim()).filter(Boolean),
    // 智能体审核（策略外调用的综合判断）：OpenAI 兼容接口，支持逗号分隔多模型取安全交集
    guardBaseUrl: env.FEISHU_GUARD_BASE_URL || undefined,
    guardModels: (env.FEISHU_GUARD_MODELS ?? env.FEISHU_GUARD_MODEL ?? "").split(",").map((m) => m.trim()).filter(Boolean),
    guardApiKey: env.FEISHU_GUARD_API_KEY ?? env.FEISHU_PI_MODEL_API_KEY,
    guardTimeoutMs: Number(env.FEISHU_GUARD_TIMEOUT_MS) > 0 ? Number(env.FEISHU_GUARD_TIMEOUT_MS) : 15_000,
    // 各组归属关系：解析 FEISHU_GROUP_<NAME>=成员1,成员2,... 格式；
    // 纯数字后缀映射为团队组名（FEISHU_GROUP_1 → group_1，与 permissions.json 的 group_1/group_2 对应）
    groupMembership: Object.fromEntries(
      Object.entries(env)
        .filter(([key]) => key.startsWith("FEISHU_GROUP_"))
        .map(([key, value]) => {
          const suffix = key.slice("FEISHU_GROUP_".length);
          const groupName = /^\d+$/.test(suffix) ? `group_${suffix}` : suffix.toLowerCase();
          return [
            groupName,
            (value ?? "").split(",").map((s) => s.trim()).filter(Boolean),
          ];
        }),
    ),
    approvalTimeoutMs: Number(env.FEISHU_APPROVAL_TIMEOUT_MS) > 0 ? Number(env.FEISHU_APPROVAL_TIMEOUT_MS) : 5 * 60_000,
    // 回复末尾的模型统计小字：默认显示；FEISHU_SHOW_MODEL_STATS=0/false/off 关闭（工具过程状态不受影响）
    showModelStats: parseBoolEnv(env.FEISHU_SHOW_MODEL_STATS, true),
  };
}
