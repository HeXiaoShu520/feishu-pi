import { describe, expect, it } from "vitest";
import { ThrottledReply } from "../src/feishu/throttled-reply.ts";
import type { FeishuReply } from "../src/feishu/types.ts";

class FakeReply implements FeishuReply {
  updates: string[] = [];
  closed = "";

  async update(text: string): Promise<void> {
    this.updates.push(text);
  }

  async close(text: string): Promise<void> {
    this.closed = text;
  }
}

describe("ThrottledReply", () => {
  it("coalesces updates and flushes the final text", async () => {
    const fake = new FakeReply();
    const reply = new ThrottledReply(fake, 10);
    reply.update("a");
    reply.update("ab");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await reply.close("abc");

    expect(fake.updates).toEqual(["ab"]);
    expect(fake.closed).toBe("abc");
  });
});
