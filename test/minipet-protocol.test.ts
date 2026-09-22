import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { MiniPetServer } from "../src/minipet/server.ts";
import {
  MINIPET_PROTOCOL,
  HISTORY_GET,
  HISTORY_RESULT,
  INPUT_ACCEPTED,
  SESSION_HELLO,
  SESSION_READY,
  SURFACE_UPDATE,
  USER_APPROVAL,
  USER_CANCEL,
  USER_INPUT,
  envelope,
  parseEnvelope,
  parseUserInput,
} from "../src/minipet/protocol.ts";
import { buildPermissionCard, buildResultCard } from "../src/guard/card.ts";

interface Channel {
  input: PassThrough;
  output: PassThrough;
  received: Array<Record<string, unknown>>;
  waitFor: (predicate: (message: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
}

function createChannel(): Channel {
  const input = new PassThrough();
  const output = new PassThrough();
  const received: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  let buffer = "";

  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      received.push(message);
      for (let index = waiters.length - 1; index >= 0; index--) {
        const waiter = waiters[index];
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        waiters.splice(index, 1);
        waiter.resolve(message);
      }
    }
  });

  const waitFor = (predicate: (message: Record<string, unknown>) => boolean) => {
    const existing = received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((item) => item.timer === timer);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("等待 MiniPet JSONL 事件超时"));
      }, 3000);
      waiters.push({ predicate, resolve, reject, timer });
    });
  };

  return { input, output, received, waitFor };
}

function send(channel: Channel, message: object): void {
  channel.input.write(JSON.stringify(message) + "\n");
}

const options = {
  userOpenId: "minipet_user",
  maxResourceBytes: 20 * 1024 * 1024,
  maxMessageResourceBytes: 40 * 1024 * 1024,
};

describe("MiniPet minipet.v1 协议", () => {
  it("解析握手信封与请求 ID", () => {
    const message = parseEnvelope({
      version: "1.0",
      type: SESSION_HELLO,
      request_id: "hello-1",
      payload: { protocol: MINIPET_PROTOCOL },
    });
    expect(message).toEqual({
      version: "1.0",
      type: SESSION_HELLO,
      request_id: "hello-1",
      payload: { protocol: MINIPET_PROTOCOL },
    });
  });

  it("保留 MiniPet 会话 ID，并为缺省轮次补关联字段", () => {
    const input = parseUserInput({
      version: "1.0",
      type: USER_INPUT,
      payload: {
        text: "你好",
        session_id: "chat-1",
        attachments: [{ type: "image", encoding: "base64", data: "aGVsbG8=" }],
      },
    });
    expect(input?.text).toBe("你好");
    expect(input?.sessionId).toBe("chat-1");
    expect(input?.turnId).toMatch(/^turn-/);
    expect(input?.surfaceId).toBe(`surface-${input?.turnId}`);
    expect(input?.attachments).toHaveLength(1);
  });

  it("构造协议信封", () => {
    expect(envelope(SESSION_READY, { ok: true }, "hello-1")).toEqual({
      version: "1.0",
      type: SESSION_READY,
      request_id: "hello-1",
      payload: { ok: true },
    });
  });

  it("history.get 从内核会话返回稳定投影", async () => {
    const fakeConversations = {
      getHistory: async () => [
        { role: "user", content: "你好", timestamp: "2026-09-23T00:00:00.000Z" },
        { role: "assistant", content: "你好！" },
      ],
    } as unknown as import("../src/runtime/conversation-manager.ts").ConversationManager;
    const server = new MiniPetServer({ conversations: fakeConversations, ...options });
    const channel = createChannel();
    await server.start(channel.input, channel.output);
    try {
      send(channel, envelope(SESSION_HELLO, {}));
      await channel.waitFor((message) => message.type === SESSION_READY);
      send(channel, envelope(HISTORY_GET, { session_id: "chat-history" }, "history-1"));
      const result = await channel.waitFor((message) => message.type === HISTORY_RESULT);
      expect(result).toMatchObject({
        request_id: "history-1",
        payload: {
          session_id: "chat-history",
          messages: [
            { role: "user", content: "你好" },
            { role: "assistant", content: "你好！" },
          ],
        },
      });
    } finally {
      channel.input.end();
      await server.stop();
    }
  });
});

describe("MiniPetServer 本地 JSONL 通道", () => {
  it("完成 hello，并将 user.input 流式映射为 surface 事件", async () => {
    let receivedConversationId = "";
    const fakeConversations = {
      prompt: async (
        message: { conversationId: string },
        onEvent: (event: { type: "assistant_text" | "tool_started"; text?: string; toolName?: string }) => void,
      ) => {
        receivedConversationId = message.conversationId;
        onEvent({ type: "tool_started", toolName: "bash" });
        onEvent({ type: "assistant_text", text: "你好" });
        onEvent({ type: "assistant_text", text: "你好，MiniPet" });
      },
    } as unknown as import("../src/runtime/conversation-manager.ts").ConversationManager;
    const server = new MiniPetServer({ conversations: fakeConversations, ...options });
    const channel = createChannel();
    await server.start(channel.input, channel.output);

    try {
      const ready = channel.waitFor((message) => message.type === SESSION_READY);
      send(channel, envelope(SESSION_HELLO, {}));
      expect((await ready).payload).toMatchObject({ protocol: MINIPET_PROTOCOL });

      const done = channel.waitFor((message) => {
        const payload = message.payload as Record<string, unknown> | undefined;
        return message.type === SURFACE_UPDATE && payload?.status === "done";
      });
      send(channel, envelope(USER_INPUT, {
        text: "你好",
        turn_id: "turn-1",
        surface_id: "surface-1",
        session_id: "chat-1",
      }, "input-1"));
      const accepted = await channel.waitFor((message) => message.type === INPUT_ACCEPTED);
      expect(accepted).toMatchObject({
        request_id: "input-1",
        payload: { turn_id: "turn-1", surface_id: "surface-1", session_id: "chat-1" },
      });
      const finalEvent = await done;
      expect(finalEvent.payload).toMatchObject({ surface_id: "surface-1", content: "你好，MiniPet", status: "done" });
      expect(channel.received.some((message) => {
        const payload = message.payload as Record<string, unknown> | undefined;
        return (message.type === "surface.show" || message.type === SURFACE_UPDATE) && payload?.progress === "正在调用工具：bash";
      })).toBe(true);
      expect(channel.received.some((message) => message.type === "surface.show")).toBe(true);
      expect(receivedConversationId).toBe("minipet:minipet_user:chat-1");
    } finally {
      channel.input.end();
      await server.stop();
    }
  });

  it("user.cancel 会中止对应的 Pi 会话并返回失败终态", async () => {
    let release!: () => void;
    let interrupted = () => {};
    let abortCalled = false;
    const fakeConversations = {
      prompt: async (
        _message: { conversationId: string },
        _onEvent: (event: { type: "assistant_text"; text: string }) => void,
        onInterrupted?: () => void,
      ) => {
        interrupted = onInterrupted || (() => {});
        await new Promise<void>((resolve) => { release = resolve; });
      },
      abort: async () => {
        abortCalled = true;
        interrupted();
        release();
      },
    } as unknown as import("../src/runtime/conversation-manager.ts").ConversationManager;
    const server = new MiniPetServer({ conversations: fakeConversations, ...options });
    const channel = createChannel();
    await server.start(channel.input, channel.output);
    try {
      send(channel, envelope(SESSION_HELLO, {}));
      await channel.waitFor((message) => message.type === SESSION_READY);
      const started = channel.waitFor((message) => message.type === "surface.show");
      send(channel, envelope(USER_INPUT, {
        text: "中断我",
        turn_id: "turn-cancel",
        surface_id: "surface-cancel",
        session_id: "chat-cancel",
      }));
      await started;
      const failed = channel.waitFor((message) => {
        const payload = message.payload as Record<string, unknown> | undefined;
        return message.type === SURFACE_UPDATE && payload?.status === "failed";
      });
      send(channel, envelope(USER_CANCEL, { turn_id: "turn-cancel", surface_id: "surface-cancel" }));
      await failed;
      expect(abortCalled).toBe(true);
    } finally {
      release?.();
      channel.input.end();
      await server.stop();
    }
  });

  it("本地授权卡使用结构化回调，并由服务端注入调用者身份", async () => {
    let approve!: () => void;
    let approvalCallback: Record<string, string> | undefined;
    let server!: MiniPetServer;
    const fakeConversations = {
      prompt: async (
        message: { conversationId: string },
        onEvent: (event: { type: "assistant_text"; text: string }) => void,
      ) => {
        await server.sendApprovalCard(message.conversationId, buildPermissionCard({
          toolName: "bash",
          args: { command: "echo hello" },
          approvalId: "approval-1",
          token: "token-1",
          mode: "self",
        }));
        await new Promise<void>((resolve) => { approve = resolve; });
        onEvent({ type: "assistant_text", text: "已完成" });
      },
    } as unknown as import("../src/runtime/conversation-manager.ts").ConversationManager;
    server = new MiniPetServer({
      conversations: fakeConversations,
      ...options,
      userOpenId: "ou_real_user",
      onApproval: async (params) => {
        approvalCallback = params as unknown as Record<string, string>;
        approve();
        return { accepted: true, detail: "已授权一次" };
      },
    });
    const channel = createChannel();
    await server.start(channel.input, channel.output);
    try {
      send(channel, envelope(SESSION_HELLO, {}));
      await channel.waitFor((message) => message.type === SESSION_READY);
      const approvalSurface = channel.waitFor((message) => message.type === "surface.show" && Boolean((message.payload as Record<string, unknown>)?.approval_message_id));
      send(channel, envelope(USER_INPUT, {
        text: "执行命令",
        turn_id: "turn-approval",
        surface_id: "surface-approval",
        session_id: "chat-approval",
      }));
      const surface = await approvalSurface;
      const payload = surface.payload as Record<string, unknown>;
      const actions = payload.actions as Array<Record<string, unknown>>;
      const allow = actions.find((action) => action.decision === "allow_once")!;
      send(channel, envelope(USER_APPROVAL, {
        message_id: payload.approval_message_id,
        approval_id: allow.approval_id,
        token: allow.token,
        decision: allow.decision,
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(approvalCallback).toMatchObject({
        approvalId: "approval-1",
        token: "token-1",
        decision: "allow_once",
        chatId: "minipet:ou_real_user:chat-approval",
        operatorOpenId: "ou_real_user",
      });
      const result = channel.waitFor((message) => message.type === SURFACE_UPDATE && Boolean((message.payload as Record<string, unknown>)?.surface_id === payload.surface_id));
      await server.updateApprovalCard(String(payload.approval_message_id), buildResultCard("allow_once"));
      expect((await result).payload).toMatchObject({ actions: [], content_kind: "final" });
    } finally {
      approve?.();
      channel.input.end();
      await server.stop();
    }
  });
});
