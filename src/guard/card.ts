/** 敏感字段名（小写匹配），参数展示时脱敏。 */
const SENSITIVE_KEYS = ["token", "password", "api_key", "apikey", "secret", "cookie", "authorization"];

/** 命令展示上限（字符）。 */
const COMMAND_MAX_LENGTH = 1200;

export interface PermissionCardParams {
  toolName: string;
  args: unknown;
  approvalId: string;
  token: string;
}

/** 生成授权卡片（CardKit 2.0），按钮 value 携带 approval_id / token / decision。 */
export function buildPermissionCard(params: PermissionCardParams): object {
  const { toolName, args, approvalId, token } = params;
  const elements: object[] = [
    { tag: "markdown", content: `**工具：** ${toolName}` },
  ];

  // 命令/路径类参数单独展示（最多 1200 字符），其余参数脱敏后以 JSON 展示
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const commandLike = ["command", "cmd", "path", "file_path", "filePath", "content", "url"];
  const commandLines = commandLike
    .filter((key) => typeof record[key] === "string" && record[key])
    .map((key) => `${key}: ${String(record[key]).slice(0, COMMAND_MAX_LENGTH)}`);
  if (commandLines.length > 0) {
    elements.push({ tag: "markdown", content: `**内容：**\n\`\`\`\n${commandLines.join("\n").slice(0, COMMAND_MAX_LENGTH)}\n\`\`\`` });
  }

  const rest = redact(Object.fromEntries(Object.entries(record).filter(([key]) => !commandLike.includes(key))) as Record<string, unknown>) as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    elements.push({ tag: "markdown", content: `**其他参数：**\n\`\`\`json\n${JSON.stringify(rest, null, 2).slice(0, COMMAND_MAX_LENGTH)}\n\`\`\`` });
  }

  elements.push({
    tag: "markdown",
    content: "⚠️ 仅配置的管理员点击有效，授权只对当前这一次调用生效。",
  });

  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "🛡 工具调用授权请求" } },
    body: {
      elements: [
        ...elements,
        {
          tag: "button",
          width: "fill",
          text: { tag: "plain_text", content: "✅ 允许一次" },
          type: "primary",
          behaviors: [{ type: "callback", value: { action: "tool_approval", approval_id: approvalId, token, decision: "allow_once" } }],
        },
        {
          tag: "button",
          width: "fill",
          text: { tag: "plain_text", content: "❌ 拒绝" },
          type: "default",
          behaviors: [{ type: "callback", value: { action: "tool_approval", approval_id: approvalId, token, decision: "deny" } }],
        },
        {
          tag: "button",
          width: "fill",
          text: { tag: "plain_text", content: "📨 申请转发给管理员" },
          type: "default",
          behaviors: [{ type: "callback", value: { action: "forward_approval", approval_id: approvalId, token } }],
        },
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
export function buildResultCard(decision: "allow_once" | "deny" | "timeout", detail?: string): object {
  const text = decision === "allow_once" ? "✅ 已授权一次" : decision === "deny" ? "❌ 已拒绝" : "⏱ 授权已超时";
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
