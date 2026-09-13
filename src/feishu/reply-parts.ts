/**
 * 回复正文的 parts 模型与展示格式化（从 bridge 中拆出的纯展示层）。
 *
 * parts 模型：正文与工具摘要各为一段（`parts[]`），`toolPartIndices` 记录工具段位置。
 * - 精简模式滚动回收：新正文段出现时，旧工具段与旧正文全部置空，只留"最新正文段"；
 *   新工具段出现时，上一个工具段就地置空（只留当前一个）——长任务不刷屏；
 * - 详细模式：全部段落原样保留，完整执行链路可审查；
 * - 终态组装（composeFinal）：详细 = 全量；精简 = 最后一个工具段之后的正文
 *   （无则退回全部非工具段），保证已见内容不丢、结论完整可读。
 *
 * 本模块只做"内容长什么样"，不关心卡片如何推送（推送由注入的 sink 完成），可独立单测。
 */

import { sessionAlias } from "./session-alias.ts";

/** Pi 会话统计的最小结构（与 runtime/types.ts 的 SessionStats 对齐） */
interface StatsLike {
  tokens?: { total?: number | null };
  cost?: number;
  sessionId?: string;
}

/** parts 的推送通道：全量重绘（render）与增量追加（append） */
export interface ReplyPartsSink {
  /** 用给定文本整体替换当前卡片正文（精简模式回收旧内容后使用） */
  render(text: string): Promise<void>;
  /** 在卡片正文末尾追加文本（段内增量、详细模式新段时使用） */
  append(text: string): Promise<void>;
}

interface Part {
  kind: "text" | "tool";
  text: string;
}

export class ReplyParts {
  private readonly parts: Part[] = [];
  private readonly toolPartIndices: number[] = [];
  private readonly sink: ReplyPartsSink;
  private readonly isCompact: () => boolean;

  constructor(
    sink: ReplyPartsSink,
    /** 是否精简模式（bridge 按 chatId 实时判断，/detail 切换即时生效） */
    isCompact: () => boolean,
  ) {
    this.sink = sink;
    this.isCompact = isCompact;
  }

  /**
   * 追加正文：同一 assistant 消息的增量（新文本以旧文本为前缀）并入当前段只推增量；
   * 新正文段出现时，精简模式回收旧内容（全量置空后重绘），详细模式直接追加。
   */
  async appendText(text: string): Promise<void> {
    const last = this.parts[this.parts.length - 1];
    if (last?.kind === "text" && text.startsWith(last.text)) {
      const delta = text.slice(last.text.length);
      last.text = text;
      if (delta) await this.sink.append(delta);
      return;
    }

    const compact = this.isCompact();
    if (compact) for (const p of this.parts) p.text = "";
    this.parts.push({ kind: "text", text });
    if (compact) await this.sink.render(text);
    else await this.sink.append(text);
  }

  /** 追加工具摘要段：精简模式下只保留当前一个工具段（上一个就地置空）。 */
  async appendTool(toolLine: string): Promise<void> {
    const compact = this.isCompact();
    if (compact) {
      const lastTool = this.toolPartIndices[this.toolPartIndices.length - 1];
      if (lastTool !== undefined) this.parts[lastTool].text = "";
    }
    this.parts.push({ kind: "tool", text: toolLine });
    this.toolPartIndices.push(this.parts.length - 1);
    if (compact) await this.sink.render(this.parts.map((p) => p.text).join(""));
    else await this.sink.append(toolLine);
  }

  /**
   * 终态组装：详细 = 全量；精简 = 最后一个工具段之后的正文段
   * （尾段为空时退回全部非工具段，不丢已见内容）。
   */
  composeFinal(): string {
    if (!this.isCompact()) return this.parts.map((p) => p.text).join("");
    if (this.toolPartIndices.length > 0) {
      const tail = this.parts
        .slice(Math.max(...this.toolPartIndices) + 1)
        .map((p) => p.text)
        .join("");
      if (tail.trim().length > 0) return tail;
    }
    return this.parts.filter((p) => p.kind !== "tool").map((p) => p.text).join("");
  }
}

/** 工具调用行展示的最大字符数（防止超长命令/路径刷屏）。 */
const TOOL_CALL_MAX_CHARS = 300;

/**
 * 格式化一次工具调用的展示文本（卡片工具段 + 日志），把关键参数带出来：
 * bash 显示命令本身，read/write/edit 显示目标路径，
 * 其余（自定义工具）按常见字段兜底提取，最终回退展示整包参数 JSON（单行、截断）。
 */
export function formatToolCall(toolName: string, args: unknown): string {
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const firstString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      if (typeof record[key] === "string" && record[key]) return record[key] as string;
    }
    return undefined;
  };

  let detail: string | undefined;
  if (toolName === "bash") {
    detail = firstString("command");
  } else if (toolName === "read" || toolName === "write" || toolName === "edit") {
    detail = firstString("path", "file_path", "filePath");
  } else {
    // 自定义工具：按常见字段兜底提取
    detail = firstString("path", "file_path", "filePath", "url", "name", "skill", "script");
  }

  // 兜底：无法从常用字段提取时，展示整包参数（单行截断）
  if (!detail) {
    try {
      detail = JSON.stringify(args)?.replace(/\s+/g, " ");
    } catch {
      detail = undefined;
    }
  }
  if (!detail) return `正在调用 **${toolName}** …`;
  if (detail.length > TOOL_CALL_MAX_CHARS) detail = `${detail.slice(0, TOOL_CALL_MAX_CHARS)}…`;
  const escaped = detail.replace(/\n/g, " ").replace(/`/g, "'");
  return `正在调用 **${toolName}**：\`${escaped}\``;
}

/**
 * 格式化回复末尾的统计小字：
 * `模型 · 累计token（新增 x） · ctx ~n% · $费用 · 耗时 · 会话别名`。
 * 新增 token = 当前上下文累计 - prompt 前基线；缺失的字段自动省略；无统计时返回 undefined。
 */
export function formatStatsLine(input: {
  modelName?: string;
  stats?: StatsLike;
  /** prompt 前基线的累计 token（计算本次新增量） */
  baselineTotalTokens?: number;
  /** 本轮请求耗时（毫秒） */
  elapsedMs: number;
  /** 当前上下文占用百分比（模型窗口口径，区别于累计计费 token） */
  contextPercent?: number | null;
}): string | undefined {
  const { stats } = input;
  if (!stats) return undefined;

  const formatTokens = (value: number) => `${(value / 1000).toFixed(1)}K`;
  const total = stats.tokens?.total || 0;
  const deltaTokens = Math.max(0, total - (input.baselineTotalTokens || 0));
  const cost = typeof stats.cost === "number" ? `$${stats.cost.toFixed(4)}` : "";
  const ctx = input.contextPercent != null ? `ctx ~${Math.round(input.contextPercent)}%` : "";
  const elapsed = `${(input.elapsedMs / 1000).toFixed(1)}s`;

  return [
    input.modelName || "模型未知",
    `${formatTokens(total)}（新增 ${formatTokens(deltaTokens)}）`,
    ctx,
    cost,
    elapsed,
    sessionAlias(stats.sessionId),
  ]
    .filter(Boolean)
    .join(" · ");
}
