import { createBashTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { logger } from "../utils/logger.ts";

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
 *
 * 缺权限自动补授权：lark-cli 以用户身份调用时若遇到 missing_scopes 类错误
 * （用户 token 缺少该业务 scope，且该 scope 不在已授权白名单内），自动触发
 * onMissingScopes 回调（main.ts 接 UserAuthService.ensureScopes 增量 Device Flow，
 * 授权卡片发到当前会话），并把提示文案追加到工具输出，让模型转告用户完成授权后重试。
 */

/** 单个 CLI provider 的凭证注入规则（lark 内置；meegle / bitbucket … 走 extraInjections 扩展） */
export interface ProviderInjection {
  /** 命令匹配（对 bash command 做正则测试，命中才注入） */
  commandPattern: RegExp;
  /** 显式身份排除：命令命中此正则时不注入（该命令将走 CLI 自身的身份，如 --as bot） */
  excludePattern?: RegExp;
  /** 注入 token 的环境变量名（单 token 型，如 LARKSUITE_CLI_USER_ACCESS_TOKEN） */
  envToken?: string;
  /** 注入应用 ID 的环境变量名（可选，如 LARKSUITE_CLI_APP_ID） */
  envAppId?: string;
  /**
   * 多字段型注入：把凭证库里的字段值映射为环境变量。
   * 用于凭证明文出现在命令行参数的 CLI（如 bbt 的 --user/--password）——
   * 命令文本里只写变量名（`--user "$BBT_USERNAME"`），真实值经进程环境进入子进程，
   * 不出现在命令文本/会话记录/工具展示中。
   */
  envFields?: {
    /** 同步读内存缓存；undefined 表示未登录，不注入 */
    get: () => Record<string, string> | undefined;
    /** 字段名 → 环境变量名（字段缺失则跳过该变量） */
    map: Record<string, string>;
  };
  /** 该 CLI 需要的固定环境变量（如 meegle 的 MEEGLE_HOST），注入时一并写入 */
  staticEnv?: Record<string, string>;
  /** 该 provider 的同步取 token 口（读内存缓存，不触发刷新；单 token 型使用） */
  getToken?: () => string | undefined;
}

export interface IdentityBashOptions {
  cwd: string;
  /** 应用 ID（注入 envAppId 指定的变量） */
  appId: string;
  /** 当前会话用户的飞书 user token（同步读内存缓存）；undefined 表示未登录，不注入 */
  getLarkToken?: () => string | undefined;
  /**
   * lark-cli 因用户 token 缺少 scope 而失败时的回调：发起增量授权（发授权卡到当前会话），
   * 返回追加到工具输出的提示文案（undefined = 不追加）。
   */
  onMissingScopes?: (userId: string, chatId: string | undefined, scopes: string[]) => string | undefined;
  /** 当前会话用户 openId（增量授权定位用户） */
  userId?: string;
  /** 当前会话 chatId（授权卡片的目的会话） */
  chatId?: string;
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
 * 命令是否以"用户身份"调用 CLI（纯函数，供单测与授权分流）：
 * - meegle / bbt：凭证本身就是用户个人凭证，恒为用户身份；
 * - lark-cli：省略身份（或显式 --as user）时注入用户 token → 用户身份；显式 --as bot 是机器人身份 → 否。
 * 用于授权分流：用户身份操作弹"用户卡"由发起者本人确认，其余走管理员卡。
 */
export function matchesUserIdentityCli(command: string): boolean {
  if (/\bmeegle\b/.test(command) || /\bbbt\b/.test(command)) return true;
  if (/\blark[-_]?cli\b/.test(command)) return !LARK_INJECTION.excludePattern!.test(command);
  return false;
}

/**
 * 纯函数：按规则把凭证写入 spawn 环境（供单测）。
 * 逐规则判断：命令匹配、未被排除、且有可用凭证 —— 三者齐备才注入。
 * 单 token 型（envToken + getToken）与多字段型（envFields）可并存；任一凭证注入成功才写 staticEnv。
 */
export function applyCredentialInjections(
  command: string,
  env: NodeJS.ProcessEnv,
  rules: Array<ProviderInjection & { appId?: string }>,
): void {
  for (const rule of rules) {
    if (!rule.commandPattern.test(command)) continue;
    if (rule.excludePattern?.test(command)) continue;

    let injected = false;

    const token = rule.getToken?.();
    if (token && rule.envToken) {
      env[rule.envToken] = token;
      if (rule.envAppId && rule.appId) env[rule.envAppId] = rule.appId;
      injected = true;
    }

    if (rule.envFields) {
      const fields = rule.envFields.get();
      if (fields) {
        for (const [field, envName] of Object.entries(rule.envFields.map)) {
          const value = fields[field];
          if (value) env[envName] = value;
        }
        injected = true;
      }
    }

    if (injected) {
      for (const [key, value] of Object.entries(rule.staticEnv ?? {})) {
        env[key] = value;
      }
    }
  }
}

/**
 * 从 lark-cli 输出中提取缺失的用户 scope（纯函数，供单测）。
 * 命中依据：JSON 错误体中的 missing_scopes 数组（N 选 1），或 hint 里的 auth login --scope 写法。
 * 返回去重后的 scope 列表（offline_access 这类授权流程 scope 不在其中，无需补授权）。
 */
export function extractMissingScopes(output: string): string[] {
  const scopes: string[] = [];
  const add = (scope: string): void => {
    if (scope && scope !== "offline_access" && !scopes.includes(scope)) scopes.push(scope);
  };
  const arrayMatch = output.match(/"missing_scopes"\s*:\s*\[([^\]]*)\]/);
  if (arrayMatch) {
    for (const m of arrayMatch[1].matchAll(/"([^"]+)"/g)) add(m[1]);
  }
  if (scopes.length === 0) {
    for (const m of output.matchAll(/auth\s+login\s+--scope\s+"?([a-z0-9_.:+-]+)"?/gi)) add(m[1]);
  }
  return scopes.slice(0, 5);
}

/** lark-cli 用户态未登录/凭证失效的错误特征（此时补授权没用，应提示 /login）。 */
const NOT_LOGGED_IN_PATTERN = /99991668|token_invalid|user_access_token.{0,40}(invalid|expired|缺失|无效)/i;

/** 从 AgentToolResult 中拼接文本 content（缺权限提示追加用）。 */
function resultText(content: Array<{ type: string; text?: string }>): string {
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

export function createIdentityBashTool(options: IdentityBashOptions): ToolDefinition {
  const rules: Array<ProviderInjection & { appId?: string }> = [
    { ...LARK_INJECTION, getToken: options.getLarkToken, appId: options.appId },
    ...(options.extraInjections ?? []).map((rule) => ({ ...rule, appId: options.appId })),
  ];

  const tool = createBashTool(options.cwd, {
    spawnHook: (context) => {
      // 每次执行现取快照（规则内 getToken 读内存缓存，O(1) 同步），不长期持有旧 token
      applyCredentialInjections(context.command, context.env, rules);
      return context;
    },
  }) as ToolDefinition & {
    execute: (
      toolCallId: string,
      params: { command?: string },
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
  };

  if (!options.onMissingScopes) return tool;

  // 包装 execute：lark-cli 权限类失败时触发增量授权，并把提示追加给模型
  const rawExecute = tool.execute.bind(tool);
  const wrapped: typeof tool = {
    ...tool,
    execute: async (toolCallId: string, params: { command?: string }, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => {
      const result = await rawExecute(toolCallId, params, signal, onUpdate as never, ctx as never);
      try {
        const command = typeof params?.command === "string" ? params.command : "";
        if (!command.match(LARK_INJECTION.commandPattern) || command.match(LARK_INJECTION.excludePattern ?? /$^/)) {
          return result;
        }
        const output = resultText(result.content ?? []);
        const scopes = extractMissingScopes(output);
        if (scopes.length > 0) {
          const note = options.onMissingScopes!(options.userId ?? "", options.chatId, scopes);
          if (note) return { ...result, content: [...(result.content ?? []), { type: "text", text: note }] };
        }
        // 未登录（99991668）：补授权无从谈起，提示引导 /login
        if (NOT_LOGGED_IN_PATTERN.test(output)) {
          return {
            ...result,
            content: [...(result.content ?? []), {
              type: "text",
              text: "该 lark-cli 调用没有可用的用户凭证（未 /login 或 token 已失效）。请提醒用户在**私聊**中发送 /login lark 完成飞书用户授权后重试；若命令本应以机器人身份执行，请改用 `--as bot`。",
            }],
          };
        }
      } catch (error) {
        logger.warn(`[IdentityBash] 缺权限提示处理失败（不影响命令结果）: ${error instanceof Error ? error.message : String(error)}`);
      }
      return result;
    },
  };
  return wrapped;
}
