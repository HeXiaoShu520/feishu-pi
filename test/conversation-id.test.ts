import { describe, expect, it } from "vitest";
import { createConversationId } from "../src/feishu/conversation-id.ts";

describe("createConversationId", () => {
  it("separates chats", () => {
    expect(createConversationId("chat-a")).toBe("chat:chat-a");
    expect(createConversationId("chat-b")).toBe("chat:chat-b");
  });

  it("separates topics within a chat", () => {
    expect(createConversationId("chat-a", "thread-1")).toBe("chat-a:thread:thread-1");
  });
});
