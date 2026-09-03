import { readFileSync, existsSync } from "node:fs";
import { logger } from "../utils/logger.ts";

export interface WhitelistConfig {
  /** 白名单正则（匹配「工具名 + 参数」，命中即放行） */
  patterns: string[];
  /** 只读工具名单，命中直接放行；缺省用内置基线 */
  readonlyTools?: string[];
  /** 可读目录（相对 cwd），只读工具仅放行这些目录内的读取；缺省为整个工作目录 */
  readableDirs?: string[];
  /** 可写目录（相对 cwd），写操作落到这些目录时放行；缺省用内置基线 */
  writableDirs?: string[];
}

/**
 * 从 JSON 文件加载白名单配置。参照 Claude Code settings.json 的风格，支持三种格式：
 *   Claude 风格: { "permissions": { "allow": ["^read\\s", ...], "readonly_tools": [...], ... } }
 *   旧版对象:    { "patterns": [...], "readonly_tools": [...], "readable_dirs": [...], "writable_dirs": [...] }
 *   字符串数组:  ["^read\\s", "^git (status|diff|log)"]
 * 文件不存在或格式非法时返回空配置并记录警告。
 */
export function loadWhitelistConfig(path: string): WhitelistConfig {
  if (!existsSync(path)) return { patterns: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(parsed)) {
      return { patterns: parsed.filter((item): item is string => typeof item === "string") };
    }
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      // Claude 风格：permissions.allow 为白名单正则；其余只读/目录配置放在 permissions 同级
      const permissions = typeof record.permissions === "object" && record.permissions !== null
        ? (record.permissions as Record<string, unknown>)
        : undefined;
      const stringList = (value: unknown): string[] | undefined =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;

      const patterns = stringList(permissions?.allow) ?? stringList(record.patterns) ?? [];
      const readonlyTools = stringList(permissions?.readonly_tools) ?? stringList(record.readonly_tools);
      const readableDirs = stringList(permissions?.readable_dirs) ?? stringList(record.readable_dirs);
      const writableDirs = stringList(permissions?.writable_dirs) ?? stringList(record.writable_dirs);
      return { patterns, readonlyTools, readableDirs, writableDirs };
    }
    logger.warn(`[Whitelist] ${path} 格式错误（应为字符串数组或对象），已忽略`);
    return { patterns: [] };
  } catch (error) {
    logger.warn(`[Whitelist] 读取 ${path} 失败: ${error instanceof Error ? error.message : error}`);
    return { patterns: [] };
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
