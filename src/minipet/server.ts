import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ConversationManager } from "../runtime/conversation-manager.ts";
import type { FeishuContext } from "../context/types.ts";
import type { FeishuPiEvent } from "../runtime/types.ts";
import { logger } from "../utils/logger.ts";
import {
  MINIPET_CAPABILITIES,
  MINIPET_PROTOCOL,
  HISTORY_CLEAR,
  HISTORY_CLEARED,
  HISTORY_GET,
  HISTORY_RESULT,
  SESSION_HELLO,
  SESSION_READY,
  SURFACE_SHOW,
  SURFACE_UPDATE,
  USER_CANCEL,
  USER_APPROVAL,
  USER_INPUT,
  envelope,
  parseEnvelope,
  parseUserInput,
  sessionIdFromPayload,
  type MiniPetAttachment,
  type MiniPetEnvelope,
  type MiniPetInput,
} from "./protocol.ts";

interface MiniPetPeer {
  readonly id: string;
  readonly output: Writable;
}

export interface MiniPetServerOptions {
  conversations: ConversationManager;
  userOpenId: string;
  maxResourceBytes: number;
  maxMessageResourceBytes: number;
  /** MiniPet 本地授权回调；operatorOpenId 由服务端配置注入，不信任桌面端传入。 */
  onApproval?: (params: {
    approvalId: string;
    token: string;
    decision: "allow_once" | "deny";
    messageId: string;
    chatId: string;
    operatorOpenId: string;
  }) => Promise<{ accepted: boolean; detail: string }>;
}

interface DecodedImages {
  images: Array<{ data: Uint8Array; mimeType: string }>;
  rejected: number;
}

interface ActiveMiniPetTurn {
  readonly conversationId: string;
  readonly turnId: string;
  readonly surfaceId: string;
  readonly peer: MiniPetPeer;
}

interface LocalApprovalSurface {
  readonly peer: MiniPetPeer;
  readonly approvalId: string;
  readonly surfaceId: string;
  readonly turnId: string;
  readonly chatId: string;
  readonly messageId: string;
}

/**
 * MiniPet 是第二个消息入口：它只负责本地 JSONL 协议适配，实际会话、权限、工具
 * 和模型仍然全部复用 ConversationManager，因此飞书和桌面端看到的是同一套内核。
 */
export class MiniPetServer {
  private readonly options: MiniPetServerOptions;
  private readonly peers = new Set<MiniPetPeer>();
  private lineReader?: Interface;
  private stopping = false;
  private lastPeer?: MiniPetPeer;
  private readonly activeTurns = new Map<string, ActiveMiniPetTurn>();
  private readonly approvalSurfaces = new Map<string, LocalApprovalSurface>();

  constructor(options: MiniPetServerOptions) {
    this.options = options;
  }

  async start(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
    if (this.lineReader) return;
    this.stopping = false;
    const peer: MiniPetPeer = { id: randomUUID(), output };
    this.peers.add(peer);
    this.lastPeer = peer;
    const lineReader = createInterface({ input, crlfDelay: Infinity });
    this.lineReader = lineReader;
    lineReader.on("line", (line) => {
      void this.handleMessage(peer, line);
    });
    lineReader.on("close", () => {
      this.peers.delete(peer);
      if (this.lastPeer === peer) this.lastPeer = undefined;
      if (this.lineReader === lineReader) this.lineReader = undefined;
      if (!this.stopping && process.argv.includes("--stdio")) {
        process.kill(process.pid, "SIGTERM");
      }
    });
    logger.info("[MiniPet] 本地 JSONL 通道已就绪");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const lineReader = this.lineReader;
    this.lineReader = undefined;
    lineReader?.close();
    this.peers.clear();
    this.lastPeer = undefined;
    this.activeTurns.clear();
    this.approvalSurfaces.clear();
    logger.info("[MiniPet] 本地 JSONL 通道已关闭");
  }

  private async handleMessage(peer: MiniPetPeer, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      this.send(peer, envelope("error", { code: "invalid_json", message: "消息不是合法 JSON" }));
      return;
    }
    const message = parseEnvelope(parsed);
    if (!message) {
      this.send(peer, envelope("error", { code: "invalid_envelope", message: "消息缺少合法 type" }));
      return;
    }
    await this.dispatch(peer, message);
  }

  private async dispatch(peer: MiniPetPeer, message: MiniPetEnvelope): Promise<void> {
    if (message.type === SESSION_HELLO) {
      const requestedProtocol = message.payload.protocol;
      if (requestedProtocol !== undefined && requestedProtocol !== MINIPET_PROTOCOL) {
        this.send(peer, envelope("error", { code: "unsupported_protocol", message: `不支持协议 ${String(requestedProtocol)}` }, message.request_id));
        return;
      }
      this.send(
        peer,
        envelope(SESSION_READY, {
          protocol: MINIPET_PROTOCOL,
          server: { name: "mini-claw", version: "0.1.0" },
          capabilities: MINIPET_CAPABILITIES,
        }, message.request_id),
      );
      return;
    }
    if (message.type === HISTORY_GET) {
      await this.handleHistoryGet(peer, message.payload, message.request_id);
      return;
    }
    if (message.type === HISTORY_CLEAR) {
      await this.handleHistoryClear(peer, message.payload, message.request_id);
      return;
    }
    if (message.type === USER_CANCEL) {
      await this.handleCancel(peer, message.payload);
      return;
    }
    if (message.type === USER_APPROVAL) {
      await this.handleApproval(peer, message.payload);
      return;
    }
    if (message.type === USER_INPUT) {
      const input = parseUserInput(message);
      if (!input) {
        this.sendSurface(peer, {
          turnId: "invalid-input",
          surfaceId: `surface-${randomUUID()}`,
          status: "failed",
          content: "无法识别这条输入。",
          timeoutMs: 6000,
        });
        return;
      }
      await this.handleUserInput(peer, input);
    }
  }

  private async handleUserInput(peer: MiniPetPeer, input: MiniPetInput): Promise<void> {
    const conversationId = this.conversationId(input.sessionId);
    const activeKey = `${peer.id}:${input.surfaceId}`;
    const context = this.contextFor(conversationId);
    const decoded = decodeImages(input.attachments, this.options.maxResourceBytes, this.options.maxMessageResourceBytes);
    const promptText = decoded.rejected > 0
      ? `${input.text}\n\n[已忽略 ${decoded.rejected} 个超出大小限制的图片附件]`
      : input.text;
    let latestText = "";
    let interrupted = false;
    const startedAt = Date.now();

    this.activeTurns.set(activeKey, {
      conversationId,
      turnId: input.turnId,
      surfaceId: input.surfaceId,
      peer,
    });

    this.sendSurface(peer, {
      turnId: input.turnId,
      surfaceId: input.surfaceId,
      status: "streaming",
      content: "正在处理…",
      timeoutMs: 60_000,
      contentKind: "progress",
      ttsEligible: false,
    });
    logger.userInput("MiniPet", input.preview || input.text);

    try {
      await this.options.conversations.prompt(
        {
          conversationId,
          prompt: { text: promptText, images: decoded.images },
          context,
        },
        async (event) => {
          if (interrupted) return;
          this.handleAgentEvent(peer, input, event, () => latestText, (text) => {
            latestText = text;
          });
        },
        () => {
          interrupted = true;
          this.sendSurface(peer, {
            turnId: input.turnId,
            surfaceId: input.surfaceId,
            status: "failed",
            content: "本轮响应已被新消息打断。",
            timeoutMs: 3000,
            contentKind: "progress",
            ttsEligible: false,
          });
        },
      );
      if (interrupted) return;
      const finalText = latestText || "（本轮无文本输出）";
      this.sendSurface(peer, {
        turnId: input.turnId,
        surfaceId: input.surfaceId,
        status: "done",
        content: finalText,
        timeoutMs: displayTimeout(finalText),
        progress: "",
        contentKind: "final",
        ttsEligible: true,
      });
      logger.aiResponse("MiniPet", `响应完成(${((Date.now() - startedAt) / 1000).toFixed(1)}s): ${finalText.slice(0, 160)}`);
    } catch (error) {
      if (interrupted) return;
      const detail = error instanceof Error ? error.message : String(error);
      this.sendSurface(peer, {
        turnId: input.turnId,
        surfaceId: input.surfaceId,
        status: "failed",
        content: `处理失败：${detail}`,
        timeoutMs: 9000,
        progress: "",
        contentKind: "final",
        ttsEligible: false,
      });
      logger.error(`[MiniPet] 处理输入失败（${conversationId}）:`, error);
    } finally {
      if (this.activeTurns.get(activeKey)?.turnId === input.turnId) this.activeTurns.delete(activeKey);
    }
  }

  private conversationId(sessionId: string): string {
    return `minipet:${this.options.userOpenId}:${sessionId}`;
  }

  private contextFor(conversationId: string): FeishuContext {
    return {
      userOpenId: this.options.userOpenId,
      userName: "MiniPet",
      chatId: conversationId,
      chatMode: "p2p",
      conversationId,
      isAdmin: false,
    };
  }

  private async handleHistoryGet(peer: MiniPetPeer, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const sessionId = sessionIdFromPayload(payload);
    const conversationId = this.conversationId(sessionId);
    try {
      const messages = await this.options.conversations.getHistory(conversationId, this.contextFor(conversationId));
      this.send(peer, envelope(HISTORY_RESULT, { session_id: sessionId, messages }, requestId));
    } catch (error) {
      this.send(peer, envelope("error", {
        code: "history_unavailable",
        message: error instanceof Error ? error.message : String(error),
        session_id: sessionId,
      }, requestId));
    }
  }

  private async handleHistoryClear(peer: MiniPetPeer, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const sessionId = sessionIdFromPayload(payload);
    const conversationId = this.conversationId(sessionId);
    try {
      await this.options.conversations.reset(conversationId, this.options.userOpenId);
      this.send(peer, envelope(HISTORY_CLEARED, { session_id: sessionId }, requestId));
    } catch (error) {
      this.send(peer, envelope("error", {
        code: "history_clear_failed",
        message: error instanceof Error ? error.message : String(error),
        session_id: sessionId,
      }, requestId));
    }
  }

  private handleAgentEvent(
    peer: MiniPetPeer,
    input: MiniPetInput,
    event: FeishuPiEvent,
    getText: () => string,
    setText: (text: string) => void,
  ): void {
    if (event.type === "assistant_text") {
      setText(event.text);
      this.sendSurface(peer, {
        turnId: input.turnId,
        surfaceId: input.surfaceId,
        status: "streaming",
        content: event.text || "正在处理…",
        timeoutMs: 60_000,
        progress: "",
        contentKind: "final",
        ttsEligible: true,
      });
      return;
    }
    if (event.type === "tool_started" || event.type === "tool_updated" || event.type === "tool_finished") {
      const toolName = event.toolName || "工具";
      const progress = event.type === "tool_started"
        ? `正在调用工具：${toolName}`
        : event.type === "tool_finished"
          ? (event.isError ? `工具执行失败：${toolName}` : `工具执行完成：${toolName}`)
          : `工具执行中：${toolName}`;
      this.sendSurface(peer, {
        turnId: input.turnId,
        surfaceId: input.surfaceId,
        status: "streaming",
        content: getText() || "正在处理…",
        timeoutMs: 60_000,
        progress,
        contentKind: "progress",
        ttsEligible: false,
      });
    }
  }

  private async handleCancel(peer: MiniPetPeer, payload: Record<string, unknown>): Promise<void> {
    const surfaceId = typeof payload.surface_id === "string" ? payload.surface_id : "";
    const turnId = typeof payload.turn_id === "string" ? payload.turn_id : "";
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
    const active = [...this.activeTurns.values()].find((item) =>
      item.peer === peer && (
        (surfaceId && item.surfaceId === surfaceId) ||
        (turnId && item.turnId === turnId) ||
        (!surfaceId && !turnId && sessionId && item.conversationId.endsWith(`:${sessionId}`))
      ),
    );
    if (!active) return;
    await this.options.conversations.abort(active.conversationId);
  }

  /**
   * 给 self 模式授权卡使用的本地投递入口。
   * 返回的 messageId 带 peer 绑定，后续更新/撤回不会误作用到另一条桌面连接。
   */
  async sendApprovalCard(chatId: string, card: object): Promise<string> {
    if (!/^ou_[A-Za-z0-9_]+$/.test(this.options.userOpenId)) {
      throw new Error("MiniPet 本地授权已关闭：请配置真实的 MINIPET_USER_OPEN_ID（ou_...）");
    }
    const active = [...this.activeTurns.values()].find((item) => item.conversationId === chatId);
    if (!active) throw new Error("MiniPet 授权卡没有对应的活动会话");
    const surface = localCardSurface(card);
    if (!surface.approvalId || !surface.token || !surface.actions.length) {
      throw new Error("授权卡缺少服务端校验字段");
    }
    const messageId = `minipet-card:${active.peer.id}:${surface.approvalId}`;
    const local: LocalApprovalSurface = {
      peer: active.peer,
      approvalId: surface.approvalId,
      surfaceId: `approval-${surface.approvalId}`,
      turnId: active.turnId,
      chatId,
      messageId,
    };
    this.approvalSurfaces.set(messageId, local);
    this.send(active.peer, envelope(SURFACE_SHOW, {
      turn_id: local.turnId,
      surface_id: local.surfaceId,
      status: "done",
      content: surface.content,
      title: surface.title || "工具调用授权",
      actions: surface.actions,
      timeout_ms: 0,
      content_kind: "final",
      tts_eligible: false,
      approval_message_id: messageId,
    }));
    return messageId;
  }

  /** PermissionBroker 的卡片更新适配器。 */
  async updateApprovalCard(messageId: string, card: object): Promise<void> {
    const local = this.approvalSurfaces.get(messageId);
    if (!local) throw new Error("MiniPet 授权卡不存在或已处理");
    const surface = localCardSurface(card);
    this.send(local.peer, envelope(SURFACE_UPDATE, {
      turn_id: local.turnId,
      surface_id: local.surfaceId,
      status: "done",
      content: surface.content,
      title: surface.title || "工具调用授权结果",
      actions: [],
      timeout_ms: 6000,
      content_kind: "final",
      tts_eligible: false,
    }));
    this.approvalSurfaces.delete(messageId);
  }

  /** PermissionBroker 的卡片撤回适配器。 */
  async recallApprovalCard(messageId: string): Promise<void> {
    const local = this.approvalSurfaces.get(messageId);
    if (!local) return;
    this.send(local.peer, envelope("surface.close", {
      turn_id: local.turnId,
      surface_id: local.surfaceId,
    }));
    this.approvalSurfaces.delete(messageId);
  }

  private async handleApproval(peer: MiniPetPeer, payload: Record<string, unknown>): Promise<void> {
    const messageId = typeof payload.message_id === "string" ? payload.message_id : "";
    const local = this.approvalSurfaces.get(messageId);
    if (!local || local.peer !== peer) {
      logger.warn("[MiniPet] 拒绝未登记的本地授权卡回调");
      return;
    }
    const approvalId = typeof payload.approval_id === "string" ? payload.approval_id : "";
    const token = typeof payload.token === "string" ? payload.token : "";
    const decision = payload.decision === "allow_once" || payload.decision === "deny" ? payload.decision : undefined;
    if (!approvalId || !token || !decision || approvalId !== local.approvalId) {
      logger.warn("[MiniPet] 拒绝字段不完整或授权 ID 不匹配的回调");
      return;
    }
    const result = await this.options.onApproval?.({
      approvalId,
      token,
      decision,
      messageId,
      chatId: local.chatId,
      // 身份来自服务端配置，而不是桌面按钮或 payload。
      operatorOpenId: this.options.userOpenId,
    });
    if (!result) return;
    if (!result.accepted) logger.warn(`[MiniPet] 本地授权回调被拒绝: ${result.detail}`);
  }

  private sendSurface(
    peer: MiniPetPeer,
    args: {
      turnId: string;
      surfaceId: string;
      status: "streaming" | "done" | "failed";
      content: string;
      timeoutMs: number;
      progress?: string;
      contentKind?: "final" | "progress";
      ttsEligible?: boolean;
    },
  ): void {
    const payload: Record<string, unknown> = {
      turn_id: args.turnId,
      surface_id: args.surfaceId,
      content: args.content,
      status: args.status,
      timeout_ms: args.timeoutMs,
      title: "mini-claw",
      avatar_kind: "pet",
    };
    if (args.progress !== undefined) payload.progress = args.progress;
    if (args.contentKind !== undefined) payload.content_kind = args.contentKind;
    if (args.ttsEligible !== undefined) payload.tts_eligible = args.ttsEligible;
    this.send(
      peer,
      envelope(args.status === "streaming" ? (args.content === "正在处理…" ? SURFACE_SHOW : SURFACE_UPDATE) : SURFACE_UPDATE, payload),
    );
  }

  private send(peer: MiniPetPeer, message: MiniPetEnvelope): void {
    try {
      peer.output.write(JSON.stringify(message) + "\n");
    } catch (error) {
      logger.warn("[MiniPet] 写入本地通道失败:", error);
    }
  }
}

interface LocalCardSurface {
  title: string;
  content: string;
  approvalId?: string;
  token?: string;
  actions: Array<Record<string, unknown>>;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** 将服务端 CardKit 2.0 授权卡转换成 MiniPet 的本地 surface；不把卡片按钮文本当命令发送。 */
function localCardSurface(card: object): LocalCardSurface {
  const root = recordValue(card) ?? {};
  const header = recordValue(root.header);
  const headerTitle = recordValue(header?.title);
  const body = recordValue(root.body);
  const elements = Array.isArray(body?.elements) ? body.elements : [];
  const text: string[] = [];
  const actions: Array<Record<string, unknown>> = [];
  let approvalId: string | undefined;
  let token: string | undefined;

  const readButton = (button: unknown): void => {
    const item = recordValue(button);
    if (!item || item.tag !== "button") return;
    const label = recordValue(item.text)?.content;
    const behavior = Array.isArray(item.behaviors) ? recordValue(item.behaviors[0]) : undefined;
    const value = recordValue(behavior?.value);
    const decision = value?.decision;
    if (value?.action !== "tool_approval" || typeof value.approval_id !== "string" || typeof value.token !== "string") return;
    if (decision !== "allow_once" && decision !== "deny") return;
    approvalId ??= value.approval_id;
    token ??= value.token;
    actions.push({
      id: `approval-${decision}`,
      label: typeof label === "string" ? label : decision === "allow_once" ? "允许一次" : "拒绝",
      style: item.type === "primary" ? "primary" : decision === "deny" ? "danger" : "default",
      action_type: "approval",
      keep_open: true,
      approval_id: value.approval_id,
      token: value.token,
      decision,
    });
  };

  for (const element of elements) {
    const item = recordValue(element);
    if (!item) continue;
    if (item.tag === "markdown" && typeof item.content === "string") {
      text.push(item.content);
    } else if (item.tag === "column_set" && Array.isArray(item.columns)) {
      for (const column of item.columns) {
        const columnRecord = recordValue(column);
        for (const child of Array.isArray(columnRecord?.elements) ? columnRecord.elements : []) readButton(child);
      }
    } else {
      readButton(item);
    }
  }
  return {
    title: typeof headerTitle?.content === "string" ? headerTitle.content : "工具调用授权",
    content: text.join("\n\n") || "请确认本次工具调用。",
    approvalId,
    token,
    actions,
  };
}

function decodeImages(attachments: MiniPetAttachment[], maxSingleBytes: number, maxTotalBytes: number): DecodedImages {
  const images: Array<{ data: Uint8Array; mimeType: string }> = [];
  let total = 0;
  let rejected = 0;
  for (const attachment of attachments) {
    if (attachment.type !== "image" || attachment.encoding !== "base64" || !attachment.data) continue;
    try {
      const data = Buffer.from(attachment.data, "base64");
      if (data.byteLength > maxSingleBytes || total + data.byteLength > maxTotalBytes) {
        rejected++;
        continue;
      }
      total += data.byteLength;
      images.push({ data: new Uint8Array(data), mimeType: attachment.mime_type || "image/png" });
    } catch {
      rejected++;
    }
  }
  return { images, rejected };
}

function displayTimeout(text: string): number {
  return Math.max(9000, Math.min(45_000, text.length * 324));
}
