import { logger } from "./utils/logger.ts";
export interface FeishuPiAppConfig {
  feishuAppId: string;
  feishuAppSecret: string;
  feishuAdmin: string;
  cwd: string;
  /** 数据根目录（data/，已被 .gitignore 排除）：非会话数据（记忆/用户/凭证/会话索引/共享缓存） */
  dataDir: string;
  /** 会话目录根（work_space/）：一次会话一个目录，会话产物全部在其中，按目录整目录过期清理 */
  sessionsRoot: string;
  /** 会话索引：conversationId → 当前会话（id/目录/Pi 会话文件） */
  sessionsFile: string;
  /** 消息去重表 */
  messagesFile: string;
  /** Per-user 授权（Device Flow，/login）申请的用户身份 scope */
  userAuthScopes: string[];
  modelProvider: string;
  modelName: string;
  modelBaseUrl?: string;
  /** 思考档位：off=关闭思考，low/high/max 各模型自动适配等效等级（FEISHU_PI_THINKING_LEVEL，默认 off） */
  thinkingLevel: ThinkingLevelConfig;
  /** 智能体审核接口（OpenAI 兼容）；未配置则策略外调用直接弹卡 */
  guardBaseUrl?: string;
  /** 审核模型列表（多个时全部 allow 才放行，任一 ask 即弹卡） */
  guardModels: string[];
  /** 未配置时回退主模型 Key */
  guardApiKey?: string;
  guardTimeoutMs: number;
  /** 各组归属关系：组名 → 成员标识列表（从 FEISHU_PI_GROUP_<NAME> 环境变量解析） */
  groupMembership: Record<string, string[]>;
  /** 授权卡片等待管理员点击的超时时间（超时视为拒绝） */
  approvalTimeoutMs: number;
  /** 回复卡末尾是否显示模型统计小字（模型 · token · ctx · 费用 · 耗时 · 会话别名）；工具过程状态不受影响 */
  showModelStats: boolean;
}

/** 由模型名推断供应商：带 claude → anthropic，带 deepseek → deepseek，其余 → openai。 */
export function deriveModelProvider(modelName: string): string {
  const n = modelName.toLowerCase();
  if (n.includes("claude")) return "anthropic";
  if (n.includes("deepseek")) return "deepseek";
  return "openai";
}

/** 布尔环境变量：未配置取 fallback；显式 1/true/on/yes 视为开，其余视为关。 */
function parseBoolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "on", "yes"].includes(value.trim().toLowerCase());
}

/** 思考档位：off=关闭思考，low/high/max 三档由各模型自动适配等效等级（pi 按模型目录夹取）。 */
const THINKING_LEVELS = ["off", "low", "high", "max"] as const;
export type ThinkingLevelConfig = (typeof THINKING_LEVELS)[number];

/** 思考档位归一：只认 off/low/high/max；旧超集档位按服务端映射表就近折算（minimal→low；medium/xhigh→high；ultra→max），其余回退默认 off。 */
function parseThinkingLevel(value: string | undefined): ThinkingLevelConfig {
  const raw = (value ?? "").trim().toLowerCase();
  if ((THINKING_LEVELS as readonly string[]).includes(raw)) return raw as ThinkingLevelConfig;
  if (raw === "") return "off";
  const equivalents: Record<string, ThinkingLevelConfig> = { minimal: "low", medium: "high", xhigh: "high", ultra: "max" };
  const folded = equivalents[raw];
  if (folded) {
    logger.warn(`[Config] FEISHU_PI_THINKING_LEVEL="${raw}" 不是公开档位，已折算为 ${folded}`);
    return folded;
  }
  logger.warn(`[Config] FEISHU_PI_THINKING_LEVEL="${raw}" 无法识别（可选 off/low/high/max），已按默认 off 处理`);
  return "off";
}

/** 主团队组名：FEISHU_PI_GROUP（无后缀）落到这里（与 permissions.json 的 group 对应） */
const PRIMARY_GROUP = "group";

/**
 * 解析组成员配置：
 * - FEISHU_PI_GROUP=x,y        → group（主团队组）
 * - FEISHU_PI_GROUP_<数字>      → group_<数字>（与 permissions.json 的组名对应）
 * - FEISHU_PI_GROUP_<组名>      → 组名小写（自定义组）
 * 同组多来源成员合并去重，保持首次出现顺序。
 */
export function parseGroupMembership(env: NodeJS.ProcessEnv): Record<string, string[]> {
  const groups = new Map<string, string[]>();
  const add = (name: string, members: string[]): void => {
    const list = groups.get(name) ?? [];
    for (const member of members) if (!list.includes(member)) list.push(member);
    groups.set(name, list);
  };
  const toMembers = (value: string | undefined): string[] =>
    (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("FEISHU_PI_GROUP")) continue;
    const raw = key.slice("FEISHU_PI_GROUP".length);
    if (raw === "") {
      // 主团队组：FEISHU_PI_GROUP → group
      add(PRIMARY_GROUP, toMembers(value));
      continue;
    }
    if (!raw.startsWith("_")) continue; // 非 FEISHU_PI_GROUP 家族的变量（防御）
    const suffix = raw.slice(1);
    if (/^\d+$/.test(suffix)) {
      add(`group_${suffix}`, toMembers(value));
      continue;
    }
    const name = suffix.toLowerCase();
    add(name, toMembers(value));
  }
  return Object.fromEntries(groups);
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
    feishuAdmin: env.FEISHU_PI_ADMIN || "", // 可选：支持中文名、英文名、open_id、邮箱
    cwd: process.cwd(),
    // 会话目录根：会话的第一句话就为它建立一个专属目录，jsonl/图片/附件全在里面
    sessionsRoot: `${process.cwd()}/work_space`,
    sessionsFile: `${process.cwd()}/data/sessions.json`,
    messagesFile: `${process.cwd()}/data/messages.json`,
    // 非会话数据（用户资料、凭证、记忆、共享缓存）统一在 data/ 下
    dataDir: `${process.cwd()}/data`,
    // 用户身份授权 scope（Device Flow）：默认内置"用户资料查询"所需最小集合；FEISHU_USER_AUTH_SCOPES 可覆盖。
    // 部门路径类 scope 需要管理员审核，默认不申请：部门信息走 lark-cli 用户态搜索通道获得
    userAuthScopes: parsedUserAuthScopes.length > 0 ? parsedUserAuthScopes : ["contact:contact.base:readonly", "contact:user.base:readonly", "contact:department.base:readonly"],
    modelName: env.FEISHU_PI_MODEL_NAME ?? "claude-sonnet-4-6",
    // 供应商由模型名推断：带 claude → anthropic、带 deepseek → deepseek、其余 → openai
    // （FEISHU_PI_MODEL_PROVIDER 环境变量已移除）
    modelProvider: deriveModelProvider(env.FEISHU_PI_MODEL_NAME ?? "claude-sonnet-4-6"),
    modelBaseUrl: env.FEISHU_PI_MODEL_BASE_URL,
    // 思考档位默认 off（关闭思考，pi 会显式发 thinking:disabled）：想开思考配 low/high/max
    thinkingLevel: parseThinkingLevel(env.FEISHU_PI_THINKING_LEVEL),
    // 智能体审核（策略外调用的综合判断）：OpenAI 兼容接口，支持逗号分隔多模型取安全交集
    guardBaseUrl: env.FEISHU_GUARD_BASE_URL || undefined,
    guardModels: (env.FEISHU_GUARD_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean),
    guardApiKey: env.FEISHU_GUARD_API_KEY ?? env.FEISHU_PI_MODEL_API_KEY,
    guardTimeoutMs: 6_000,
    // 各组归属关系：解析 FEISHU_PI_GROUP[<_N>]=成员1,成员2,... 格式；
    // FEISHU_PI_GROUP（无后缀）映射到主团队组 group，
    // FEISHU_PI_GROUP_2..N 对应 group_2..N；成员除 open_id/中英文名外还支持组织架构部门名
    // （用户缓存的部门路径包含该部门名即视为组成员，见 PermissionPolicy.groupsFor）。
    groupMembership: parseGroupMembership(env),
    approvalTimeoutMs: 5 * 60_000,
    // 回复末尾的模型统计小字：默认显示；FEISHU_SHOW_MODEL_STATS=0/false/off 关闭（工具过程状态不受影响）
    showModelStats: parseBoolEnv(env.FEISHU_SHOW_MODEL_STATS, true),
  };
}
