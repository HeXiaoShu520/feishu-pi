/**
 * 选项卡（ask_user）：AI 需要用户在多个选项中做选择时的交互闭环。
 *
 * 流程：模型调用 ask_user_question 工具 → AskBroker 向会话发"提问卡"（蓝色标题、
 * 问题 + 选项按钮，每行最多 5 个）→ 用户点选 → 卡片回调携带
 * {action:"ask_user", qid, token, choice} → 校验（存在性/一次性 token/仅本人）
 * → 唤醒等待中的工具，把选项原文作为结果返回给模型。
 *
 * 授权语义：卡片回调按 (qid, token, 提问对象 openId) 三要素校验——
 * 他人点击无效（忽略），确保"谁被提问就由谁选择"。
 */
import { randomUUID } from "node:crypto";
import type { FeishuPiTool } from "../runtime/types.ts";
import { logger } from "../utils/logger.ts";

/** 每行最多 5 个按钮（飞书单个选项行建议上限，超出拆行） */
const BUTTONS_PER_ROW = 5;
/** 按钮文本截断长度（超长补省略号，让用户知道被截了） */
const BUTTON_TEXT_MAX = 30;
/** 默认等待用户选择的超时（毫秒） */
const DEFAULT_ASK_TIMEOUT_MS = 180_000;

/** 统一换行、去行尾空格、strip */
function compactMarkdown(text: string): string {
  return text
    .split("\r\n")
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** 生成选项卡（CardKit 2.0）：蓝色标题栏 + 问题 + 灰色提示 + 分行选项按钮。 */
export function buildChoiceCard(params: {
  question: string;
  options: string[];
  qid: string;
  token: string;
}): object {
  const { question, options, qid, token } = params;

  const button = (choice: string, primary: boolean) => {
    const text = choice.length > BUTTON_TEXT_MAX ? `${choice.slice(0, BUTTON_TEXT_MAX)}…` : choice;
    return {
      tag: "button",
      text: { tag: "plain_text", content: text },
      type: primary ? "primary" : "default",
      behaviors: [{ type: "callback", value: { action: "ask_user", qid, token, choice } }],
    };
  };

  // 每行最多 5 个按钮：2~8 个选项拆成 1~2 行；第一个选项 primary 强调
  const rows: object[] = [];
  for (let i = 0; i < options.length; i += BUTTONS_PER_ROW) {
    const group = options.slice(i, i + BUTTONS_PER_ROW);
    rows.push({
      tag: "column_set",
      flex_mode: "none",
      background_style: "default",
      columns: group.map((choice, idx) => ({
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "top",
        elements: [button(choice, i === 0 && idx === 0)],
      })),
    });
  }

  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "🤖 向你提问" }, template: "blue" },
    body: {
      elements: [
        { tag: "markdown", content: compactMarkdown(question) },
        { tag: "markdown", content: "点击选项即回复此问题（仅本人选择有效，超时自动跳过）" },
        ...rows,
      ],
    },
  };
}

/** 超时/取消结果卡：替换原提问卡，不再保留可点按钮。 */
export function buildAskResultCard(text: string): object {
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "🤖 向你提问" }, template: "blue" },
    body: { elements: [{ tag: "markdown", content: text }] },
  };
}

export interface AskBrokerOptions {
  sendCard: (chatId: string, card: object) => Promise<string | undefined>;
  updateCard: (messageId: string, card: object) => Promise<void>;
  /** 等待用户选择的超时（毫秒），默认 180000（3 分钟） */
  askTimeoutMs?: number;
}

export interface AskOutcome {
  status: "answered" | "timeout" | "cancelled";
  choice?: string;
}

interface PendingAsk {
  qid: string;
  token: string;
  openId: string;
  messageId: string;
  resolve: (outcome: AskOutcome) => void;
}

export class AskBroker {
  /** 进行中的提问（qid → 待答记录） */
  private readonly pending = new Map<string, PendingAsk>();
  private readonly options: AskBrokerOptions;
  private readonly askTimeoutMs: number;

  constructor(options: AskBrokerOptions) {
    this.options = options;
    this.askTimeoutMs = options.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  }

  /**
   * 向会话发提问卡并等待用户点选（阻塞到选择/超时）。
   * qid/token 与提问对象 openId 绑定：仅本人点击有效。
   */
  async ask(openId: string, chatId: string, question: string, options: string[]): Promise<AskOutcome> {
    const qid = randomUUID();
    const token = randomUUID();
    const card = buildChoiceCard({ question, options, qid, token });
    const messageId = await this.options.sendCard(chatId, card);
    if (!messageId) return { status: "cancelled" };

    return await new Promise<AskOutcome>((resolve) => {
      const pending: PendingAsk = { qid, token, openId, messageId, resolve: (outcome) => resolve(outcome) };
      this.pending.set(qid, pending);
      const timer = setTimeout(() => {
        if (this.pending.get(qid) !== pending) return;
        this.pending.delete(qid);
        void this.options
          .updateCard(messageId, buildAskResultCard("⏱ 已超时跳过本次选择。如需回答请重新提问。"))
          .catch(() => undefined)
          .finally(() => pending.resolve({ status: "timeout" }));
      }, this.askTimeoutMs);
      pending.resolve = (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      };
    });
  }

  /**
   * 卡片回调结算：校验存在性 / 一次性 token / 仅本人；
   * 通过 → 更新结果卡并返回所选原文；非本人点击 → 忽略（返回 undefined）。
   */
  resolve(input: { qid?: string; token?: string; choice?: string; operatorOpenId?: string; messageId?: string }): AskOutcome | undefined {
    const pending = this.pending.get(input.qid ?? "");
    if (!pending || pending.token !== input.token) return undefined;
    if (input.operatorOpenId !== pending.openId) {
      logger.warn(`[AskBroker] 非提问对象点击被忽略：提问对象 ${pending.openId}，点击者 ${input.operatorOpenId}`);
      return undefined;
    }
    this.pending.delete(input.qid ?? "");
    const choice = input.choice ?? "";
    const messageId = input.messageId ?? pending.messageId ?? "";
    void this.options
      .updateCard(messageId, buildAskResultCard(`✅ 已选择：${choice}`))
      .catch(() => undefined);
    return { status: "answered", choice };
  }
}

/**
 * ask_user_question 工具：模型需要用户在多个选项中做选择时调用。
 * 阻塞等待点选/超时，把所选选项原文作为工具结果返回给模型。
 */
export function createAskUserTool(broker: AskBroker): FeishuPiTool {
  return {
    name: "ask_user_question",
    label: "ask_user_question",
    description:
      "需要用户在多个选项中做出选择时使用：向用户展示问题与候选项（2~8 个），等待点选后返回所选选项原文。" +
      "用户超时未选会返回超时状态，此时应以文本形式重新询问或基于已有信息继续",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "要问用户的问题，表述完整清晰" },
        options: { type: "array", items: { type: "string" }, description: "2~8 个候选项，每项一句完整表述" },
      },
      required: ["question", "options"],
    },
    execute: async (_toolCallId, params) => {
      const record = (typeof params === "object" && params !== null ? params : {}) as {
        question?: string;
        options?: string[];
        _caller?: { openId?: string; chatId?: string };
      };
      const question = (record.question ?? "").trim();
      const options = Array.isArray(record.options)
        ? record.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 8)
        : [];
      const openId = record._caller?.openId ?? "";
      const chatId = record._caller?.chatId ?? "";
      if (!question || options.length < 2) {
        return { content: [{ type: "text" as const, text: "❌ 参数不完整：需要 question 与至少 2 个 options" }], details: {} };
      }
      const outcome = await broker.ask(openId, chatId, question, options);
      if (outcome.status === "answered" && outcome.choice) {
        return { content: [{ type: "text" as const, text: `用户选择了：${outcome.choice}` }], details: {} };
      }
      if (outcome.status === "timeout") {
        return { content: [{ type: "text" as const, text: "用户超时未选择。请以文本形式重新询问，或基于已有信息继续任务，不要默认替用户选择" }], details: {} };
      }
      return { content: [{ type: "text" as const, text: "本次询问已取消" }], details: {} };
    },
  };
}
