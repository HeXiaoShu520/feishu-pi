import { resolve, sep } from "node:path";
import { logger } from "../utils/logger.ts";

export type GuardDecision = "allow" | "ask";

export interface JudgeVerdict {
  decision: GuardDecision;
  reason: string;
}

export interface SafetyJudgeOptions {
  cwd: string;
  /** Guard 大模型（OpenAI 兼容接口）配置 */
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  timeoutMs: number;
}

/** 无需大模型即可放行的只读工具。 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "ls", "find", "restricted_read", "todo_read"]);

/** 写入这些目录（相对 cwd）视为低风险，直接放行。 */
const WRITABLE_DIRS = [".agent", "data"];

const SYSTEM_PROMPT = `你是一个工具调用安全审核器。你会收到一次 AI Agent 即将执行的工具调用（工具名和参数）。
请判断该调用是否安全到可以无需人工确认直接执行：
- 只读操作（读取、查询、搜索、列出、计算等无副作用操作）→ allow
- 写入/修改项目工作目录内的文件、常规低风险操作 → allow
- 删除文件/目录、覆盖工作目录外的路径、执行网络外发（发消息、上传、发布）、安装/卸载软件、修改系统配置、执行来源不明的命令 → ask
- 无法确定时一律 → ask
仅输出 JSON，不要输出其他内容：{"decision":"allow"|"ask","reason":"简短中文理由"}`;

/**
 * 大模型 Guard：规则先判（只读放行、可写目录放行），其余交给轻量大模型审核。
 * 任何异常（未配置、超时、接口错误、返回无法解析）一律按 ask 处理，避免误放行。
 */
export class SafetyJudge {
  private readonly options: SafetyJudgeOptions;

  constructor(options: SafetyJudgeOptions) {
    this.options = options;
  }

  /** 对一次工具调用给出裁决：allow 直接放行，ask 需要管理员授权。 */
  async judge(toolName: string, args: unknown): Promise<JudgeVerdict> {
    // 规则层 1：只读工具直接放行，不消耗大模型调用
    if (READ_ONLY_TOOLS.has(toolName)) {
      return { decision: "allow", reason: "只读工具" };
    }

    // 规则层 2：写工具写入可写目录时放行，写其他路径一律 ask
    if (toolName === "write" || toolName === "edit") {
      const target = extractPath(args);
      if (target && isUnderWritableDir(target, this.options.cwd)) {
        return { decision: "allow", reason: "写入可写目录" };
      }
      return { decision: "ask", reason: "写入可写目录之外，需管理员确认" };
    }

    // 其余交给大模型判断
    return this.judgeWithModel(toolName, args);
  }

  /** 调用 OpenAI 兼容接口让轻量大模型审核；异常一律返回 ask。 */
  private async judgeWithModel(toolName: string, args: unknown): Promise<JudgeVerdict> {
    const { baseUrl, model, apiKey, timeoutMs } = this.options;
    if (!baseUrl || !model) {
      return { decision: "ask", reason: "Guard 模型未配置" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `工具名: ${toolName}\n参数: ${JSON.stringify(args) ?? "{}"}` },
          ],
        }),
      });
      if (!response.ok) {
        return { decision: "ask", reason: `Guard 接口异常 HTTP ${response.status}` };
      }
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content ?? "";
      const verdict = parseVerdict(text);
      if (!verdict) {
        return { decision: "ask", reason: "Guard 返回格式无法解析" };
      }
      return verdict;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn(`[Guard] 大模型审核失败，按 ask 处理: ${detail}`);
      return { decision: "ask", reason: "Guard 审核异常，默认需人工确认" };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 从写工具参数中提取目标路径（兼容 path/file_path/file_path 字段）。 */
function extractPath(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return undefined;
}

/** 判断目标路径是否落在 cwd 下的可写目录内（拒绝 ../ 逃逸）。 */
function isUnderWritableDir(target: string, cwd: string): boolean {
  const abs = resolve(cwd, target);
  return WRITABLE_DIRS.some((dir) => {
    const base = resolve(cwd, dir) + sep;
    return (abs + sep).startsWith(base);
  });
}

/** 从模型返回文本中提取 JSON 裁决；解析失败返回 undefined。 */
function parseVerdict(text: string): JudgeVerdict | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as { decision?: string; reason?: string };
    if (parsed.decision === "allow") return { decision: "allow", reason: parsed.reason || "Guard 放行" };
    if (parsed.decision === "ask") return { decision: "ask", reason: parsed.reason || "Guard 要求人工确认" };
    return undefined;
  } catch {
    return undefined;
  }
}
