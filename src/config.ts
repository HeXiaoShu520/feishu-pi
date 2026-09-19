import { join } from "node:path";
import { readFileSync } from "node:fs";
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
  /** 思考档位：off=关闭思考（默认），low/high/max 各模型自动适配等效等级（FEISHU_PI_THINKING_LEVEL） */
  thinkingLevel: ThinkingLevelConfig;
  /** 会话工作区根目录：每个会话一个子文件夹（jsonl/图片/附件都归拢于此） */
  workspaceRoot: string;
  /** 本地 OCR 兜底：模型无视觉能力时，把下载图片 OCR 成文字一并交给模型（FEISHU_USE_EXTRA_OCR） */
  useExtraOcr: boolean;
  /** 自定义人格（PERSONA.md 全文，置于系统提示最前）；缺失 = 使用内置默认人格 */
  systemPrompt?: string;
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

/**
 * 自定义人格：读取仓库根目录 PERSONA.md 全文（trim 后），作为系统提示最前置的人格段。
 * 文件缺失或为空 → undefined（使用内置默认人格）。
 */
function readPersona(cwd: string): string | undefined {
  try {
    const text = readFileSync(join(cwd, "PERSONA.md"), "utf8").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
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

/** 思考档位归一：只认 off/low/high/max；旧超集档位就近折算（minimal→low、medium→high、xhigh→max），其余回退默认 off。 */
function parseThinkingLevel(value: string | undefined): ThinkingLevelConfig {
  const raw = (value ?? "").trim().toLowerCase();
  if ((THINKING_LEVELS as readonly string[]).includes(raw)) return raw as ThinkingLevelConfig;
  const equivalents: Record<string, ThinkingLevelConfig> = { minimal: "low", medium: "high", xhigh: "max" };
  return equivalents[raw] ?? "off";
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
    sessionDir: `${process.cwd()}/data/sessions`,
    // 会话工作区：第一句话就为会话建立专属文件夹，图片/附件等一切产物归拢于此
    workspaceRoot: `${process.cwd()}/work_space`,
    dataDir: `${process.cwd()}/data`,
    // 用户身份授权 scope（Device Flow）：默认内置"用户资料查询"所需最小集合；FEISHU_USER_AUTH_SCOPES 可覆盖。
    // 部门路径类 scope 需要管理员审核，默认不申请：部门信息走 lark-cli 用户态搜索通道获得
    userAuthScopes: parsedUserAuthScopes.length > 0 ? parsedUserAuthScopes : ["contact:contact.base:readonly", "contact:user.base:readonly", "contact:department.base:readonly"],
    modelName: env.FEISHU_PI_MODEL_NAME ?? "claude-sonnet-4-6",
    // 供应商由模型名推断：带 claude → anthropic、带 deepseek → deepseek、其余 → openai
    // （FEISHU_PI_MODEL_PROVIDER 环境变量已移除）
    modelProvider: deriveModelProvider(env.FEISHU_PI_MODEL_NAME ?? "claude-sonnet-4-6"),
    modelBaseUrl: env.FEISHU_PI_MODEL_BASE_URL,
    // FEISHU_PI_MODEL_VISION=1 → 模型声明含图片输入（覆盖内置目录的过时元数据）
    // 本地 OCR 兜底（tesseract.js，首次联网下载语言包）：模型无视觉能力时把图片文字识别后交给模型
    useExtraOcr: parseBoolEnv(env.FEISHU_USE_EXTRA_OCR, false),
    // 思考档位默认 off（关闭思考，响应最快）：pi 默认会显式发 thinking:disabled，
    // 想开思考配 low/high/max，各模型自动适配等效等级
    thinkingLevel: parseThinkingLevel(env.FEISHU_PI_THINKING_LEVEL),
    // 自定义人格：独立文件 PERSONA.md（不入 .env），缺失 = 内置默认人格
    systemPrompt: readPersona(process.cwd()),
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
