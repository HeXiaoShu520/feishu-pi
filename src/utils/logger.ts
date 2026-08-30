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

export const logger = {
  info: (...args: any[]) => console.info(`${colors.gray}[${timestamp()}]${colors.reset}`, ...args),
  warn: (...args: any[]) => console.warn(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.yellow}[warn]${colors.reset}`, ...args),
  error: (...args: any[]) => console.error(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.red}[error]${colors.reset}`, ...args),
  log: (...args: any[]) => console.log(`${colors.gray}[${timestamp()}]${colors.reset}`, ...args),

  // 用户输入（蓝色）
  userInput: (userName: string, message: string) => {
    console.info(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.blue}[${userName}]${colors.reset} ${message}`);
  },

  // AI 响应（绿色）
  aiResponse: (userName: string, message: string) => {
    console.info(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.green}[${userName}]${colors.reset} ${message}`);
  },
};
