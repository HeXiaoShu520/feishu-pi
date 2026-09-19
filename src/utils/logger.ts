/**
 * 日志工具 - 所有日志带时间前缀
 */

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// ANSI 颜色码
export const colors = {
  gray: '\x1b[90m',
  reset: '\x1b[0m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  bright: '\x1b[1m',
};

// 模块标签颜色：日志行开头的 [Tag] 按模块着色，一眼区分来源；不在表内的标签保持无色
const TAG_COLORS: Record<string, string> = {
  Runtime: '\x1b[35m', // magenta
  Policy: '\x1b[36m', // cyan
  Conversation: '\x1b[36m',
  LarkTransport: '\x1b[36m',
  CardKit: '\x1b[35m',
  CardAction: '\x1b[35m',
  Config: '\x1b[33m',
  ToolGuard: '\x1b[33m',
  IdentityBash: '\x1b[33m',
  Judge: '\x1b[34m',
  UserAuth: '\x1b[34m',
  Bridge: '\x1b[32m',
  CredAuth: '\x1b[32m',
  MeegleAuth: '\x1b[32m',
  Main: '\x1b[1m',
};

/** 把字符串开头的 [Tag] 染成对应模块色（未知标签原样返回） */
function colorizeTag(arg: unknown): unknown {
  if (typeof arg !== 'string') return arg;
  return arg.replace(/^\[([A-Za-z]+)\]/, (m, name: string) => {
    const color = TAG_COLORS[name];
    return color ? `${color}[${name}]${colors.reset}` : m;
  });
}

export const logger = {
  info: (...args: unknown[]) => console.info(`${colors.gray}[${timestamp()}]${colors.reset}`, ...args.map(colorizeTag)),
  warn: (...args: unknown[]) => console.warn(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.yellow}[warn]${colors.reset}`, ...args.map(colorizeTag)),
  error: (...args: unknown[]) => console.error(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.red}[error]${colors.reset}`, ...args.map(colorizeTag)),
  log: (...args: unknown[]) => console.log(`${colors.gray}[${timestamp()}]${colors.reset}`, ...args.map(colorizeTag)),

  // 用户输入（蓝色）
  userInput: (userName: string, message: string) => {
    console.info(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.blue}[${userName}]${colors.reset} ${colorizeTag(message)}`);
  },

  // AI 响应（绿色）
  aiResponse: (userName: string, message: string) => {
    console.info(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.green}[${userName}]${colors.reset} ${colorizeTag(message)}`);
  },
};
