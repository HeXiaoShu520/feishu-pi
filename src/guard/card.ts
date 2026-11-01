/** 敏感字段名（小写匹配），参数展示时脱敏。 */
const SENSITIVE_KEYS = ["token", "password", "api_key", "apikey", "secret", "cookie", "authorization"];

/** 命令展示上限（字符）。 */
const COMMAND_MAX_LENGTH = 1200;

/** 授权卡参数 */
export interface PermissionCardParams {
  /** 待审核的工具名 */
  toolName: string;
  /** 工具调用参数（展示前脱敏） */
  args: unknown;
  /** 一次授权请求的唯一 ID */
  approvalId: string;
  /** 一次性随机 token，回调时服务端比对 */
  token: string;
  /** 模型审核或高风险标记要求本人确认的原因。 */
  reason?: string;
}

/** 提取工具调用的一句话摘要（command/path 等关键字段，单行截断）。 */
function summarizeArgs(args: unknown): string {
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const first = ["command", "cmd", "path", "file_path", "filePath", "url", "pattern"].map((k) => record[k]).find((v) => typeof v === "string" && v) as string | undefined;
  const detail = first ?? (Object.keys(record).length > 0 ? JSON.stringify(redact(record)).replace(/\s+/g, " ") : "");
  return detail.slice(0, COMMAND_MAX_LENGTH).replace(/\n/g, " ").replace(/`/g, "'");
}

/** 生成本人确认卡片（CardKit 2.0）：工具摘要、原因与两个按钮。 */
export function buildPermissionCard(params: PermissionCardParams): object {
  const { toolName, args, approvalId, token, reason } = params;

  const summary = summarizeArgs(args);
  // 与流式工具段同形态：统一渲染为代码块——bash 带 bash 语言标注，
  // 其余工具代码块首行带工具名（授权场景需明确动作，路径类也不例外）；
  // 围栏内出现 ``` 会破坏渲染，替换为三单引号
  const safe = summary.replace(/```/g, "'''");
  const lang = toolName === "bash" ? "bash" : "";
  const body = toolName === "bash" ? safe : `${toolName}\n${safe}`;
  const toolBlock = "```" + `${lang}\n${body}\n` + "```";
  const button = (text: string, type: string, value: Record<string, unknown>) => ({
    tag: "button",
    width: "fill",
    text: { tag: "plain_text", content: text },
    type,
    behaviors: [{ type: "callback", value }],
  });
  const columns = [
    { tag: "column", width: "weighted", weight: 1, vertical_align: "top", elements: [button("✅ 允许一次", "primary", { action: "tool_approval", approval_id: approvalId, token, decision: "allow_once" })] },
    { tag: "column", width: "weighted", weight: 1, vertical_align: "top", elements: [button("❌ 拒绝", "default", { action: "tool_approval", approval_id: approvalId, token, decision: "deny" })] },
  ];
  const buttonsRow = {
    tag: "column_set",
    flex_mode: "none",
    background_style: "default",
    columns,
  };

  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "🔑 本人操作确认" } },
    body: {
      elements: [
        { tag: "markdown", content: toolBlock },
        {
          tag: "markdown",
          content: "⚠️ 请确认本次工具操作。仅你本人点击有效，授权仅本次生效",
        },
        ...(reason ? [{ tag: "markdown", content: reason.slice(0, 500).replace(/[<>`]/g, "") }] : []),
        buttonsRow,
      ],
    },
  };
}

/** 提示卡：替换原卡片内容，不保留按钮。 */
export function buildNoticeCard(text: string): object {
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "🛡 工具调用授权" } },
    body: { elements: [{ tag: "markdown", content: text }] },
  };
}

/** 决策结果卡：替换原授权卡，不再保留可点击按钮。 */
export function buildResultCard(decision: "allow_once" | "deny" | "timeout" | "cancelled", detail?: string): object {
  const text =
    decision === "allow_once" ? "✅ 已授权一次" :
    decision === "deny" ? "❌ 已拒绝" :
    decision === "timeout" ? "⏱ 授权已超时" :
    "⏹ 会话已中断，授权已取消";
  const reason = detail ? `\n\n${detail}` : "";
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "🛡 工具调用授权结果" } },
    body: { elements: [{ tag: "markdown", content: `${text}${reason}` }] },
  };
}

/** 递归脱敏：敏感字段替换为 ***。 */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "***";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEYS.includes(key.toLowerCase()) ? "***" : redact(item, depth + 1),
      ]),
    );
  }
  return value;
}
