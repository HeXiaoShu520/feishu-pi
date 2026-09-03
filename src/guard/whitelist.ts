import { readFileSync, existsSync } from "node:fs";
import { logger } from "../utils/logger.ts";

/**
 * 从 JSON 文件加载白名单正则（字符串数组，如 ["^read\\s", "^git (status|diff|log)"]）。
 * 文件不存在或格式非法时返回空数组并记录警告。
 */
export function loadWhitelistPatterns(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(parsed)) {
      logger.warn(`[Whitelist] ${path} 格式错误（应为字符串数组），已忽略`);
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string");
  } catch (error) {
    logger.warn(`[Whitelist] 读取 ${path} 失败: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

/**
 * 指令白名单：按配置的正则匹配工具调用内容，命中即自动放行（不弹授权卡）。
 * 每条正则依次匹配「工具名 + 参数文本」的拼接结果，任一命中即视为白名单内。
 */
export class CommandWhitelist {
  private readonly sources: string[] = [];
  private readonly patterns: RegExp[] = [];

  constructor(patterns: string[]) {
    for (const raw of patterns) {
      try {
        this.patterns.push(new RegExp(raw));
        this.sources.push(raw);
      } catch (error) {
        logger.warn(`[Whitelist] 无效的正则已跳过: ${raw} (${error instanceof Error ? error.message : error})`);
      }
    }
  }

  /** 返回命中的正则原文；未命中返回 undefined。 */
  match(toolName: string, args: unknown): string | undefined {
    const text = `${toolName} ${serializeArgs(args)}`;
    const index = this.patterns.findIndex((pattern) => pattern.test(text));
    return index >= 0 ? this.sources[index] : undefined;
  }
}

/** 将工具参数序列化为可匹配的文本（单行）。 */
function serializeArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}
