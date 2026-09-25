import { createBashTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { startCliProxy } from "./cli-proxy.ts";

/**
 * 会话级"带身份"的 bash 工具：以同名自定义工具覆盖 Pi 内置 bash（pi 的工具注册为
 * customTools 后写覆盖）。shell 只持有本次调用的本地代理句柄；每条 CLI 真正启动时
 * 才按当前会话用户取得凭证，普通 shell 命令不接触 token 或应用密钥。
 *
 * 身份契约（由技能/命令写法决定，与用户约定一致）：
 * - 命令省略身份或显式 `--as user` → 只给该次 CLI 子进程发起人的用户 token；
 * - 显式 `--as bot` → 只给该次 CLI 子进程当前应用的 App ID/Secret；
 * - 每次调用使用临时的 CLI 配置目录，隔离宿主机账号缓存；
 * - 用户未登录 / token 过期 → 拒绝执行并发起授权，不回退到 CLI 默认账号。
 *
 * 进程级隔离：凭证 env 只作用于 CLI 子进程，无全局状态，多用户并发互不可见。
 *
 * 缺权限自动补授权：lark-cli 以用户身份调用时若遇到 missing_scopes 类错误
 * （用户 token 缺少该业务 scope，且该 scope 不在已授权白名单内），自动触发
 * onMissingScopes 回调（main.ts 接 UserAuthService.ensureScopes 增量 Device Flow，
 * 授权卡片发到当前会话），并把提示文案追加到工具输出，让模型转告用户完成授权后重试。
 */

/** 单个 CLI provider 的凭证注入规则（lark 内置；其他 CLI 可经 extraInjections 扩展） */
export interface ProviderInjection {
  /** 命令匹配（对 bash command 做正则测试，命中才注入） */
  commandPattern: RegExp;
  /** 显式身份排除：命令命中此正则时不注入（该命令将走 CLI 自身的身份，如 --as bot） */
  excludePattern?: RegExp;
  /** 需要按实际 shell 参数而非原始字符串判断的排除规则。 */
  excludeWhen?: (command: string) => boolean;
  /** 注入 token 的环境变量名（单 token 型，如 LARKSUITE_CLI_USER_ACCESS_TOKEN） */
  envToken?: string;
  /** 注入应用 ID 的环境变量名（可选，如 LARKSUITE_CLI_APP_ID） */
  envAppId?: string;
  /** 该 CLI 需要的固定环境变量（如 meegle 的 MEEGLE_HOST），命中命令即注入 */
  staticEnv?: Record<string, string>;
  /** 该 provider 的同步取 token 口（读内存缓存，不触发刷新；单 token 型使用） */
  getToken?: () => string | undefined;
}

export interface IdentityBashOptions {
  cwd: string;
  /** 应用 ID（注入 envAppId 指定的变量） */
  appId: string;
  /** 当前机器人应用密钥，仅在显式 --as bot 时交给 lark-cli 子进程。 */
  appSecret: string;
  /** 读取飞书历史卡片时用于排除机器人自己的 @。 */
  botOpenId?: string;
  /** 管理员用户令牌只供固定资料入库，不交给 AI CLI。 */
  adminSender?: boolean;
  /** 当前会话用户的飞书 user token（同步读内存缓存）；undefined 表示未登录，用户态调用拒绝执行 */
  getLarkToken?: () => string | undefined;
  /** 仅在当前发起人实际执行 lark-cli 用户命令前加载或刷新其令牌。 */
  ensureLarkToken?: () => Promise<string | undefined>;
  /**
   * lark-cli 因用户 token 缺少 scope 而失败时的回调：发起增量授权（发授权卡到当前会话），
   * 返回追加到工具输出的提示文案（undefined = 不追加）。
   */
  onMissingScopes?: (userId: string, chatId: string | undefined, scopes: string[]) => string | undefined;
  /** lark-cli 未登录/凭证失效时的回调：主动发起 Device Flow（授权链接卡推送到用户私聊） */
  onNotLoggedIn?: (userId: string) => void;
  /** 当前会话用户 openId（增量授权定位用户） */
  userId?: string;
  /** 当前会话 chatId（授权卡片的目的会话） */
  chatId?: string;
  /** 扩展位：其他 CLI 接入时追加各自的匹配与 env 映射 */
  extraInjections?: ProviderInjection[];
}

/** shell 参数分词：引号内的 `--as bot` 是普通文本，不能被当成身份选项。 */
function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const char of command) {
    if (escaped) { word += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = undefined; else word += char; continue; }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === "#" && !started) break; // bash 注释后的文字不是 CLI 参数
    if (/\s/.test(char)) {
      if (started) { words.push(word); word = ""; started = false; }
      continue;
    }
    word += char;
    started = true;
  }
  if (quote || escaped) return undefined;
  if (started) words.push(word);
  return words;
}

function hasExplicitBotIdentity(command: string): boolean {
  const words = shellWords(command);
  if (!words) return false;
  return words.some((word, index) => word === "--as=bot" || (word === "--as" && words[index + 1] === "bot"));
}

/** 仅允许一条直接 CLI 命令取得发起人的凭证，避免复合 shell 命令共享 token。 */
export function isDirectIdentityCliCommand(command: string, cli: "lark" | "meegle"): boolean {
  const prefix = cli === "lark" ? /^\s*lark[-_]?cli(?:\.exe)?(?:\s|$)/i : /^\s*meegle(?:\.exe)?(?:\s|$)/i;
  if (!prefix.test(command) || /[`$\r\n]/.test(command)) return false;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const char of command) {
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/[;&|<>]/.test(char) || char === "(" || char === ")") return false;
  }
  return !quote && !escaped;
}

/**
 * 命令是否以"用户身份"调用 lark-cli（纯函数，供单测与授权分流）：
 * 省略身份（或显式 --as user）时注入用户 token → 用户身份；显式 --as bot 是机器人身份 → 否。
 * 用于授权分流：用户身份操作弹"用户卡"由发起者本人确认，其余走管理员卡。
 */
export function matchesUserIdentityCli(command: string): boolean {
  // 本人授权只能覆盖一条直接 CLI 调用，不能靠字符串里出现 lark-cli 就审批任意 shell。
  if (!/^\s*lark-cli\s+/.test(command) || /[;&|`$<>\\()\r\n]/.test(command)) return false;
  return !hasExplicitBotIdentity(command);
}

/**
 * 纯函数：按规则把凭证写入 spawn 环境（供单测）。
 * 逐规则判断：命令匹配、未被排除、且有可用凭证 —— 三者齐备才注入。
 */
export function applyCredentialInjections(
  command: string,
  env: NodeJS.ProcessEnv,
  rules: Array<ProviderInjection & { appId?: string }>,
): void {
  const directLark = isDirectIdentityCliCommand(command, "lark");
  const directMeegle = isDirectIdentityCliCommand(command, "meegle");
  if (!directLark && !directMeegle && /\b(?:lark[-_]?cli|meegle)\b/i.test(command)) {
    throw new Error("用户凭证只允许用于单条直接 CLI 命令，请分开执行；不会向复合命令或其他程序注入账号信息。");
  }
  for (const rule of rules) {
    if (rule.envToken) delete env[rule.envToken];
    if (!rule.commandPattern.test(command)) continue;
    if (rule.excludeWhen ? rule.excludeWhen(command) : rule.excludePattern?.test(command)) continue;

    // 固定环境变量：命令命中即注入（站点/区域等常量，与是否登录无关）
    for (const [key, value] of Object.entries(rule.staticEnv ?? {})) env[key] = value;

    const token = rule.getToken?.();
    if (rule.envToken && !token) throw new Error("当前用户未登录或凭证已过期，请完成私聊授权后重试；不会使用 CLI 的默认账号执行。");
    if (token && rule.envToken) {
      env[rule.envToken] = token;
      if (rule.envAppId && rule.appId) env[rule.envAppId] = rule.appId;
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

export function createIdentityBashTool(options: IdentityBashOptions): ToolDefinition {
  const metadata = createBashTool(options.cwd) as ToolDefinition;
  const clientPath = join(options.cwd, "src", "runtime", "cli-proxy-client.mjs").replaceAll("\\", "/");
  const quotedClient = `'${clientPath.replaceAll("'", "'\\''")}'`;
  const commandPrefix = [
    "readonly LARKSUITE_CLI_USER_ACCESS_TOKEN MEEGLE_USER_ACCESS_TOKEN",
    `function lark-cli { command node ${quotedClient} lark "$@"; }`,
    `function lark-cli.exe { lark-cli "$@"; }`,
    `function lark_cli { lark-cli "$@"; }`,
    `function lark { lark-cli "$@"; }`,
    `function meegle { command node ${quotedClient} meegle "$@"; }`,
    `function meegle.exe { meegle "$@"; }`,
  ].join("\n");
  const meegle = options.extraInjections?.find((rule) => rule.commandPattern.test("meegle help"));
  return {
    ...metadata,
    description: `${metadata.description}\n飞书/Meegle CLI 在实际启动时由机器人绑定当前发消息者身份，shell 可以正常使用 cd、管道、重定向和组合命令。用户可发送 /status 或 /login 管理授权；不要自行调用 CLI auth status/login/logout。机器人回复与卡片由内置飞书通道发送。`,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const proxy = await startCliProxy({
        cwd: options.cwd,
        appId: options.appId,
        appSecret: options.appSecret,
        botOpenId: options.botOpenId,
        adminSender: options.adminSender,
        getLarkToken: async () => await options.ensureLarkToken?.() ?? options.getLarkToken?.(),
        onLarkMissing: () => options.onNotLoggedIn?.(options.userId ?? ""),
        onLarkOutput: (output) => {
          const scopes = extractMissingScopes(output);
          if (scopes.length > 0) return options.onMissingScopes?.(options.userId ?? "", options.chatId, scopes);
          if (NOT_LOGGED_IN_PATTERN.test(output)) options.onNotLoggedIn?.(options.userId ?? "");
          return undefined;
        },
        getMeegleToken: meegle?.getToken,
        meegleEnv: meegle?.staticEnv,
      });
      try {
        const scopedTool = createBashTool(options.cwd, {
          commandPrefix,
          spawnHook: (context) => {
            for (const name of [
              "LARKSUITE_CLI_USER_ACCESS_TOKEN", "LARKSUITE_CLI_TENANT_ACCESS_TOKEN",
              "LARKSUITE_CLI_APP_ID", "LARKSUITE_CLI_APP_SECRET", "FEISHU_APP_ID", "FEISHU_APP_SECRET",
              "MEEGLE_USER_ACCESS_TOKEN",
            ]) delete context.env[name];
            // 绕过 shell 函数直接启动 CLI 时，仍强制进入“显式但无效的令牌”模式。
            // Meegle 在该环境变量存在时不会读取系统 keychain；lark-cli 也不会回退到本机用户配置。
            // 真正的令牌只由代理交给受控的 CLI 子进程。
            context.env.LARKSUITE_CLI_USER_ACCESS_TOKEN = "mini-claw-no-local-account";
            context.env.MEEGLE_USER_ACCESS_TOKEN = "mini-claw-no-local-account";
            context.env.LARKSUITE_CLI_CONFIG_DIR = proxy.configDir;
            context.env.FEISHU_PI_CLI_PROXY_PORT = String(proxy.port);
            context.env.FEISHU_PI_CLI_PROXY_KEY = proxy.key;
            return context;
          },
        });
        const executeWithContext = scopedTool.execute as unknown as (...args: unknown[]) => ReturnType<typeof scopedTool.execute>;
        return await executeWithContext(toolCallId, params, signal, onUpdate, ctx);
      } finally {
        await proxy.close();
      }
    },
  };
}
