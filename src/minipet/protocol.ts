/** MiniPet 本地 stdio JSONL 协议：边界清晰、单向流式、无端口依赖。 */

import { randomUUID } from "node:crypto";

export const MINIPET_PROTOCOL = "minipet.v1";
export const MINIPET_VERSION = "1.0";

export const SESSION_HELLO = "session.hello";
export const SESSION_READY = "session.ready";
export const USER_INPUT = "user.input";
export const USER_CANCEL = "user.cancel";
export const USER_APPROVAL = "user.approval";
export const HISTORY_GET = "history.get";
export const HISTORY_RESULT = "history.result";
export const HISTORY_CLEAR = "history.clear";
export const HISTORY_CLEARED = "history.cleared";
export const SURFACE_SHOW = "surface.show";
export const SURFACE_UPDATE = "surface.update";
export const SURFACE_CLOSE = "surface.close";

export const MINIPET_CAPABILITIES = [
  SESSION_HELLO,
  SESSION_READY,
  USER_INPUT,
  USER_CANCEL,
  USER_APPROVAL,
  HISTORY_GET,
  HISTORY_RESULT,
  HISTORY_CLEAR,
  HISTORY_CLEARED,
  SURFACE_SHOW,
  SURFACE_UPDATE,
  SURFACE_CLOSE,
] as const;

export interface MiniPetEnvelope {
  version: string;
  type: string;
  payload: Record<string, unknown>;
  request_id?: string;
}

export interface MiniPetHistoryMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

export interface MiniPetAttachment {
  type: string;
  name?: string;
  mime_type?: string;
  encoding?: string;
  data?: string;
  source?: string;
}

export interface MiniPetInput {
  text: string;
  preview?: string;
  mode: "text" | "voice" | "drop" | string;
  surface: "pet_popup" | "voice_orb" | "chat_window" | "desktop_pet" | string;
  turnId: string;
  surfaceId: string;
  sessionId: string;
  attachments: MiniPetAttachment[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** 解析一条 JSONL 消息；不信任协议外的数据。 */
export function parseEnvelope(raw: unknown): MiniPetEnvelope | undefined {
  if (!isRecord(raw)) return undefined;
  const type = stringField(raw, "type");
  if (!type) return undefined;
  if (!isSupportedType(type)) return undefined;
  if (!isRecord(raw.payload)) return undefined;
  const payload = raw.payload;
  const version = stringField(raw, "version") ?? MINIPET_VERSION;
  if (version !== MINIPET_VERSION) return undefined;
  const requestId = stringField(raw, "request_id");
  return requestId ? { version, type, payload, request_id: requestId } : { version, type, payload };
}

/** 协议边界上的最小字段校验；业务层不再接收任意版本的 JSON。 */
export function isSupportedType(type: string): boolean {
  return (MINIPET_CAPABILITIES as readonly string[]).includes(type);
}

export function sessionIdFromPayload(payload: Record<string, unknown>): string {
  return stringField(payload, "session_id")
    ?? stringField(payload, "chat_session_id")
    ?? stringField(payload, "conversation_id")
    ?? "minipet:global";
}

/** 将 user.input 变成运行时需要的最小输入模型。 */
export function parseUserInput(envelope: MiniPetEnvelope): MiniPetInput | undefined {
  if (envelope.type !== USER_INPUT) return undefined;
  const payload = envelope.payload;
  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.filter(isRecord).map((item) => ({
        type: typeof item.type === "string" ? item.type : "",
        name: stringField(item, "name"),
        mime_type: stringField(item, "mime_type"),
        encoding: stringField(item, "encoding"),
        data: typeof item.data === "string" ? item.data : undefined,
        source: stringField(item, "source"),
      }))
    : [];
  const text = stringField(payload, "text") ?? stringField(payload, "preview") ?? (attachments.length ? "请处理我发送的附件" : "");
  if (!text && attachments.length === 0) return undefined;
  const turnId = stringField(payload, "turn_id") ?? `turn-${randomUUID()}`;
  const surfaceId = stringField(payload, "surface_id") ?? `surface-${turnId}`;
  const sessionId =
    stringField(payload, "session_id") ??
    stringField(payload, "chat_session_id") ??
    stringField(payload, "conversation_id") ??
    "default";
  return {
    text,
    preview: stringField(payload, "preview"),
    mode: stringField(payload, "mode") ?? "text",
    surface: stringField(payload, "surface") ?? "pet_popup",
    turnId,
    surfaceId,
    sessionId,
    attachments,
  };
}

export function envelope(type: string, payload: Record<string, unknown>, requestId?: string): MiniPetEnvelope {
  const result: MiniPetEnvelope = { version: MINIPET_VERSION, type, payload };
  if (requestId) result.request_id = requestId;
  return result;
}
