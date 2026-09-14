import { createBashTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * 会话级"带身份"的 bash 工具：以同名自定义工具覆盖 Pi 内置 bash（pi 的工具注册为
 * customTools 后写覆盖），在每次 spawn 前按当前会话用户注入 CLI 凭证环境变量。
 *
 * 身份契约（由技能/命令写法决定，与用户约定一致）：
 * - 命令省略身份（如 `lark-cli calendar +agenda`）→ 注入发起人的用户 token → 以发起人身份执行；
 * - 命令显式 `--as bot`（应用级操作，如发消息）→ 不注入 → lark-cli 走自身 bot 身份；
 *   注意 lark-cli 的安全设计：env 注入的用户 token 存在时，该次调用被强制限定为 user
 *   身份（strict mode 自动派生），显式 --as bot 会报错而非静默覆盖——因此必须在此跳过注入；
 * - 用户未登录 / token 过期 → 不注入，lark-cli 走默认身份（调用方以 99991668 等错误提示 /login）。
 *
 * 进程级隔离：env 只作用于本次 spawn 的子进程，无全局状态，多用户并发互不可见。
 */

/** 单个 CLI provider 的凭证注入规则（lark 内置；meegle / bitbucket … 走 extraInjections 扩展） */
export interface ProviderInjection {
  /** 命令匹配（对 bash command 做正则测试，命中才注入） */
  commandPattern: RegExp;
  /** 显式身份排除：命令命中此正则时不注入（该命令将走 CLI 自身的身份，如 --as bot） */
  excludePattern?: RegExp;
  /** 注入 token 的环境变量名（如 LARKSUITE_CLI_USER_ACCESS_TOKEN） */
  envToken: string;
  /** 注入应用 ID 的环境变量名（可选，如 LARKSUITE_CLI_APP_ID） */
  envAppId?: string;
  /** 该 provider 的同步取 token 口（读内存缓存，不触发刷新） */
  getToken?: () => string | undefined;
}

export interface IdentityBashOptions {
  cwd: string;
  /** 应用 ID（注入 envAppId 指定的变量） */
  appId: string;
  /** 当前会话用户的飞书 user token（同步读内存缓存）；undefined 表示未登录，不注入 */
  getLarkToken?: () => string | undefined;
  /** 扩展位：其他 CLI 接入时追加各自的匹配与 env 映射 */
  extraInjections?: ProviderInjection[];
}

/** lark-cli 内置规则：命令显式请求 bot 身份（--as bot / --as=bot）时不注入用户凭证 */
const LARK_INJECTION: ProviderInjection = {
  commandPattern: /\blark[-_]?cli\b/,
  excludePattern: /(^|[\s;|&])--as(=|\s+)bot(\s|$)/i,
  envToken: "LARKSUITE_CLI_USER_ACCESS_TOKEN",
  envAppId: "LARKSUITE_CLI_APP_ID",
  getToken: undefined, // 由 createIdentityBashTool 注入 options.getLarkToken
};

/**
 * 纯函数：按规则把凭证写入 spawn 环境（供单测）。
 * 逐规则判断：命令匹配、未被排除、且有可用 token —— 三者齐备才注入。
 */
export function applyCredentialInjections(
  command: string,
  env: NodeJS.ProcessEnv,
  rules: Array<ProviderInjection & { appId?: string }>,
): void {
  for (const rule of rules) {
    const token = rule.getToken?.();
    if (!token) continue;
    if (!rule.commandPattern.test(command)) continue;
    if (rule.excludePattern?.test(command)) continue;
    env[rule.envToken] = token;
    if (rule.envAppId && rule.appId) env[rule.envAppId] = rule.appId;
  }
}

export function createIdentityBashTool(options: IdentityBashOptions): ToolDefinition {
  const rules: Array<ProviderInjection & { appId?: string }> = [
    { ...LARK_INJECTION, getToken: options.getLarkToken, appId: options.appId },
    ...(options.extraInjections ?? []).map((rule) => ({ ...rule, appId: options.appId })),
  ];

  return createBashTool(options.cwd, {
    spawnHook: (context) => {
      // 每次执行现取快照（规则内 getToken 读内存缓存，O(1) 同步），不长期持有旧 token
      applyCredentialInjections(context.command, context.env, rules);
      return context;
    },
  }) as ToolDefinition;
}
