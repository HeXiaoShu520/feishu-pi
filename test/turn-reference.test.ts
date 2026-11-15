import { describe, expect, it, vi } from "vitest";
import { SessionWrapper } from "../src/runtime/feishu-pi-runtime.ts";

describe("每轮资料只进入模型请求", () => {
  it("画像证据只在本轮模型执行期间有效，失败后也清理", async () => {
    let active: string | undefined;
    const raw = { prompt: vi.fn(async () => { expect(active).toBe("原始本人正文"); throw new Error("abort"); }) } as unknown as ConstructorParameters<typeof SessionWrapper>[0];
    const session = new SessionWrapper(raw, { onProfileTurn: text => { active = text; } });
    await expect(session.prompt({ text: "含引用的包装文本", memoryText: "原始本人正文" })).rejects.toThrow("abort");
    expect(active).toBeUndefined();
  });
  it("原文用于历史，记忆用原始正文检索，只给最后一条user临时加资料", async () => {
    let projection: Array<{ role: string; content: string }> = [];
    const original = [{ role: "user", content: "以前的一句话" }, { role: "user", content: "A: 喝咖啡了" }];
    const agent = { transformContext: async (messages: typeof original, _signal?: AbortSignal) => messages };
    const prompt = vi.fn(async (_text: string) => { projection = await agent.transformContext(original); });
    const raw = { agent, prompt } as unknown as ConstructorParameters<typeof SessionWrapper>[0];
    const recall = vi.fn(async (query: string) => `检索:${query}`);
    const session = new SessionWrapper(raw, { roleContext: "普通朋友", recall });
    await session.prompt({ text: "A: 喝咖啡了", memoryText: "喝咖啡了", turnContext: "本轮时间资料" });
    expect(recall).toHaveBeenCalledWith("喝咖啡了");
    expect(prompt.mock.calls[0][0]).toBe("A: 喝咖啡了");
    expect(original[1].content).toBe("A: 喝咖啡了");
    expect(projection[0]).toEqual(original[0]);
    expect(projection[1].content).toContain("检索:喝咖啡了");
    expect(projection[1].content).toContain("本轮时间资料");
    expect((await agent.transformContext(original))[1].content).toBe("A: 喝咖啡了");
  });
});
