import { describe, expect, it, vi } from "vitest";
import { SessionWrapper, recallWithDeadline } from "../src/runtime/feishu-pi-runtime.ts";

describe("记忆使用当前发言人的正文", () => {
  it("不把上下文和引用原文当作当前用户的记忆", async () => {
    const recall = vi.fn().mockResolvedValue("");
    const observe = vi.fn().mockResolvedValue(undefined);
    const branch: unknown[] = [];
    const raw = {
      sessionManager: { getBranch: () => branch },
      prompt: vi.fn(async (_text: string, _options?: unknown) => {
        branch.push({ type: "message", message: { role: "user", content: "当前消息" } });
        branch.push({ type: "message", message: { role: "assistant", content: "记住了" } });
      }),
    };
    const session = new SessionWrapper(raw as never, { recall, observe });
    await session.prompt({ text: "[上下文] 引用：小王喜欢猫\n我喜欢草莓", memoryText: "我喜欢草莓" });
    expect(recall).toHaveBeenCalledWith("我喜欢草莓");
    expect(observe.mock.calls[0][0]).toBe("我喜欢草莓");
    expect(raw.prompt.mock.calls[0][0]).toContain("小王喜欢猫");
    await session.prompt({ text: "[飞书引用]无关内容\n不对，是樱桃", memoryText: "不对，是樱桃" });
    const history = observe.mock.calls[1][2] as Array<{ content: string }>;
    expect(history.map(item => item.content)).toEqual(["我喜欢草莓", "记住了", "不对，是樱桃", "记住了"]);
    expect(JSON.stringify(history)).not.toContain("小王喜欢猫");
  });

  it("召回超时后正常继续", async () => {
    expect(await recallWithDeadline(new Promise<string>(() => {}), 5)).toBe("");
  });

  it("临时记忆仅对当前轮生效，不写入会话，也不会残留在以后上下文", async () => {
    const stored: Array<{ role: string; content: unknown }> = [];
    let transformedDuringPrompt: unknown[] = [];
    const originalTransform = vi.fn(async (messages: unknown[]) => messages);
    const raw = {
      agent: { transformContext: originalTransform },
      sessionManager: {
        appendMessage: (message: { role: string; content: unknown }) => { stored.push(message); return "id"; },
        getBranch: () => stored.map(message => ({ type: "message", message })),
      },
      prompt: vi.fn(async (text: string) => {
        raw.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }, { type: "image", data: "picture" }] });
        transformedDuringPrompt = await raw.agent.transformContext([{ role: "user", content: [{ type: "text", text }] }]);
        raw.sessionManager.appendMessage({ role: "assistant", content: "好的" });
      }),
    };
    const session = new SessionWrapper(raw as never, { recall: vi.fn().mockResolvedValue("- 喜欢草莓"), observe: vi.fn().mockResolvedValue(undefined) });
    await session.prompt({ text: "你好吗", memoryText: "你好吗" });
    expect(raw.prompt.mock.calls[0][0]).toBe("你好吗");
    expect(JSON.stringify(transformedDuringPrompt)).toContain("喜欢草莓");
    expect(JSON.stringify(stored)).not.toContain("喜欢草莓");
    expect(stored[0].content).toEqual([{ type: "text", text: "你好吗" }, { type: "image", data: "picture" }]);
    const transformed = await raw.agent.transformContext([
      { role: "user", content: [{ type: "text", text: "你好吗" }] },
      { role: "assistant", content: "好的" },
      { role: "user", content: [{ type: "text", text: "下一轮" }] },
    ]);
    expect(JSON.stringify(transformed[0])).not.toContain("喜欢草莓");
    expect(JSON.stringify(transformed[2])).not.toContain("喜欢草莓");
    expect(originalTransform).toHaveBeenCalledTimes(2);
  });

  it("请求失败后清除本轮参考，避免泄漏到下一轮", async () => {
    const raw = {
      agent: { transformContext: async (messages: unknown[]) => messages },
      sessionManager: { getBranch: () => [] },
      prompt: vi.fn(async (_text: string) => { throw new Error("中断"); }),
    };
    const session = new SessionWrapper(raw as never, { recall: vi.fn().mockResolvedValue("- 喜欢草莓"), observe: vi.fn().mockResolvedValue(undefined) });
    await expect(session.prompt({ text: "嗨" })).rejects.toThrow("中断");
    const after = await raw.agent.transformContext([{ role: "user", content: "之后的消息" }]);
    expect(JSON.stringify(after)).not.toContain("喜欢草莓");
  });
  it("仅在询问近期聊天时注入对话片段，并记录当前实际对话", async () => {
    const branch: unknown[] = [];
    const captured: string[] = [];
    const recent = { recall: vi.fn().mockResolvedValue("近期：去爬山"), search: vi.fn().mockResolvedValue("关于蓝鲸的片段"), record: vi.fn().mockResolvedValue(undefined) };
    const raw = {
      agent: { transformContext: async (messages: unknown[]) => messages },
      sessionManager: { getBranch: () => branch },
      prompt: vi.fn(async (text: string) => {
        const context = await raw.agent.transformContext([{ role: "user", content: text }]);
        captured.push(JSON.stringify(context));
        branch.push({ type: "message", message: { role: "user", content: text } }, { type: "message", message: { role: "assistant", content: "好的" } });
      }),
    };
    const session = new SessionWrapper(raw as never, { recall: vi.fn().mockResolvedValue(""), observe: vi.fn().mockResolvedValue(undefined) }, undefined, recent);
    await session.prompt({ text: "你好" });
    await session.prompt({ text: "上次我们聊了什么？" });
    await session.prompt({ text: "我们之前聊过蓝鲸吗？" });
    expect(captured[0]).not.toContain("去爬山");
    expect(captured[1]).toContain("去爬山");
    expect(captured[2]).toContain("关于蓝鲸的片段");
    expect(recent.search).toHaveBeenCalledWith("蓝鲸");
    expect(recent.record).toHaveBeenCalledWith("你好", "好的");
    expect(recent.recall).toHaveBeenCalledTimes(1);
  });
  it("长期记忆和历史片段并行读取", async () => {
    let releaseMemory!: (value: string) => void;
    let releaseHistory!: (value: string) => void;
    const memory = { recall: vi.fn(() => new Promise<string>(resolve => { releaseMemory = resolve; })), observe: vi.fn().mockResolvedValue(undefined) };
    const recent = { recall: vi.fn().mockResolvedValue(""), search: vi.fn(() => new Promise<string>(resolve => { releaseHistory = resolve; })), record: vi.fn().mockResolvedValue(undefined) };
    const raw = { sessionManager: { getBranch: () => [] }, prompt: vi.fn().mockResolvedValue(undefined) };
    const session = new SessionWrapper(raw as never, memory, undefined, recent);
    const turn = session.prompt({ text: "我们之前聊过蓝鲸吗？" });
    expect(memory.recall).toHaveBeenCalledOnce();
    expect(recent.search).toHaveBeenCalledOnce();
    releaseMemory("");
    releaseHistory("");
    await turn;
  });
});
