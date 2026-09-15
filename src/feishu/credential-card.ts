/**
 * 凭证提交表单卡：form 容器 + input 组件 + form_submit 按钮。
 *
 * 为什么用卡片表单而不是让用户把 token 发在聊天里：聊天消息会明文留在会话记录中
 * （对端/会话成员/飞书服务端均可见），密码类输入框（input_type: "password"）以 • 显示，
 * 内容经 card.action.trigger 回调直达服务端加密入库，不落聊天记录。
 *
 * 线协议（飞书卡片 JSON 2.0）：
 * - 表单容器 { tag: "form" } 内嵌若干 { tag: "input", name } 与提交按钮；
 * - 按钮 action_type: "form_submit"，behaviors 携带自定义回传参数
 *   { action: "credential_submit", provider }；
 * - 用户点击提交后回调 card.action.trigger：按钮回传参数在 action.value，
 *   各输入框内容在 action.form_value（{输入框name: 值}）；
 *   独立输入框（不在表单容器内）提交时内容在 action.input_value。
 */

export interface CredentialField {
  /** 表单字段名（回调 form_value 的键；卡片内唯一） */
  name: string;
  /** 输入框描述标签 */
  label: string;
  placeholder?: string;
  /** text 普通文本 / password 密码（• 显示）/ multiline_text 多行 */
  inputType?: "text" | "password" | "multiline_text";
  required?: boolean;
  maxLength?: number;
}

export interface CredentialFormOptions {
  /** 凭证归属（meegle / bbt …），随按钮回传参数原样带回 */
  provider: string;
  title: string;
  /** 卡片顶部说明（markdown） */
  intro?: string;
  fields: CredentialField[];
  submitText?: string;
  /** 底部提示（如"凭证仅加密存储，不会展示"） */
  notice?: string;
}

const plainText = (content: string): { tag: "plain_text"; content: string } => ({ tag: "plain_text", content });

/** 构建凭证提交表单卡（schema 2.0）。 */
export function buildCredentialFormCard(options: CredentialFormOptions): object {
  const inputs = options.fields.map((field) => ({
    tag: "input",
    element_id: `in_${field.name}`.slice(0, 20),
    name: field.name,
    required: field.required ?? true,
    input_type: field.inputType ?? "text",
    ...(field.maxLength ? { max_length: field.maxLength } : {}),
    placeholder: plainText(field.placeholder ?? "请输入"),
    label: plainText(field.label),
    label_position: "top",
    width: "default",
  }));

  const form = {
    tag: "form",
    name: `form_${options.provider}`,
    elements: [
      ...inputs,
      {
        tag: "button",
        text: plainText(options.submitText ?? "提交"),
        type: "primary",
        action_type: "form_submit",
        name: `btn_${options.provider}_submit`,
        behaviors: [{ type: "callback", value: { action: "credential_submit", provider: options.provider } }],
      },
      {
        tag: "button",
        text: plainText("重置"),
        type: "default",
        action_type: "form_reset",
        name: `btn_${options.provider}_reset`,
      },
    ],
  };

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: plainText(options.title) },
    body: {
      elements: [
        ...(options.intro ? [{ tag: "markdown", content: options.intro }] : []),
        form,
        ...(options.notice ? [{ tag: "markdown", content: options.notice }] : []),
      ],
    },
  };
}

/**
 * 从卡片回调中提取提交的凭证字段（纯函数，供单测）。
 * 优先 form_value（表单容器提交），为空时回退 input_value（独立输入框提交，键记为 value）。
 * 非字符串值忽略；不做任何日志输出（调用方不得把字段值写日志）。
 */
export function extractCredentialFields(rawAction: unknown): Record<string, string> {
  const action = (rawAction ?? {}) as { form_value?: unknown; input_value?: unknown };
  const fields: Record<string, string> = {};
  if (action.form_value && typeof action.form_value === "object") {
    for (const [key, value] of Object.entries(action.form_value as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) fields[key] = value.trim();
    }
  }
  if (Object.keys(fields).length === 0 && typeof action.input_value === "string" && action.input_value.trim()) {
    fields.value = action.input_value.trim();
  }
  return fields;
}
