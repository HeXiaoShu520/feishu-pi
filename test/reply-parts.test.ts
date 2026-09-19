import { describe, expect, it } from "vitest";
import { formatToolCall, ReplyParts, type ReplyPartsSink } from "../src/feishu/reply-parts.ts";

/** 记录型 sink：render 收全量，append 收增量 */
function makeSink() {
  const calls: Array<{ op: "render" | "append"; text: string }> = [];
  const sink: ReplyPartsSink = {
    render: async (text) => {
      calls.push({ op: "render", text });
    },
    append: async (text) => {
      calls.push({ op: "append", text });
    },
  };
  return { calls, sink };
}

const F = "```";

describe("ReplyParts 精简模式（滚动回收）", () => {
  it("同段增量：只推送 delta，不重绘", async () => {
    const { calls, sink } = makeSink();
    const parts = new ReplyParts(sink, () => true);

    await parts.appendText("你好");
    await parts.appendText("你好，世界");

    expect(calls).toEqual([
      { op: "render", text: "你好" },
      { op: "append", text: "，世界" },
    ]);
  });

  it("新正文段出现：旧工具段与旧正文全部置空，只渲染新段", async () => {
    const { calls, sink } = makeSink();
    const parts = new ReplyParts(sink, () => true);

    await parts.appendText("第一段正文");
    await parts.appendTool("> 动作一");
    await parts.appendText("第二段正文");

    // 最后一次 render 只含新正文段（旧内容已回收）
    const lastRender = calls.filter((c) => c.op === "render").pop();
    expect(lastRender).toEqual({ op: "render", text: "第二段正文" });
  });

  it("工具段只留当前一个：新工具出现时上一个就地置空", async () => {
    const { calls, sink } = makeSink();
    const parts = new ReplyParts(sink, () => true);

    await parts.appendTool("工具一");
    await parts.appendTool("工具二");

    const lastRender = calls.filter((c) => c.op === "render").pop();
    expect(lastRender?.text).not.toContain("工具一");
  });

  it("composeFinal：取最后一个工具段之后的正文；无尾段时退回全部非工具段", async () => {
    const { sink } = makeSink();
    const parts = new ReplyParts(sink, () => true);

    await parts.appendText("开头");
    await parts.appendTool("工具");
    await parts.appendText("结论 A");
    await parts.appendText("结论 A 完整版");
    expect(parts.composeFinal()).toBe("结论 A 完整版");

    // 工具后无正文：退回非工具段（保留"开头"，工具段不计入）
    const { sink: sink2 } = makeSink();
    const parts2 = new ReplyParts(sink2, () => true);
    await parts2.appendText("开头");
    await parts2.appendTool("工具");
    expect(parts2.composeFinal()).toBe("开头");
  });
});

describe("ReplyParts 详细模式（全量保留）", () => {
  it("不做回收：全部内容按序追加", async () => {
    const calls: string[] = [];
    const sink = {
      render: async () => {},
      append: async (t: string) => {
        calls.push(t);
      },
    };
    const parts = new ReplyParts(sink, () => false);

    await parts.appendText("第一段");
    await parts.appendTool("工具行");
    await parts.appendText("第二段");

    expect(parts.composeFinal()).toBe("第一段工具行第二段");
    expect(calls.every((c) => c.startsWith("追加:") || c === "工具行" || c === "第一段" || c === "第二段") || calls.length === 3).toBe(true);
  });
});

describe("formatToolCall 工具段格式化（代码块形态）", () => {
  it("bash：命令进 bash 代码块", () => {
    expect(formatToolCall("bash", { command: "git status" })).toBe(F + "bash\ngit status\n" + F);
  });

  it("read/write/edit：路径进代码块", () => {
    expect(formatToolCall("read", { path: "docs/a.md" })).toBe(F + "\ndocs/a.md\n" + F);
    expect(formatToolCall("edit", { file_path: "src/x.ts" })).toBe(F + "\nsrc/x.ts\n" + F);
  });

  it("自定义工具：代码块首行带工具名", () => {
    const out = formatToolCall("my_tool", { foo: "bar" });
    expect(out.startsWith(F + "\nmy_tool\n")).toBe(true);
    expect(out).toContain('"foo"');
  });

  it("超长截断；围栏内三反引号被替换", () => {
    const long = "x".repeat(400);
    const line = formatToolCall("bash", { command: long });
    expect(line.length).toBeLessThan(340);
    expect(line).toContain("…");
    const ticks = "```";
    expect(formatToolCall("bash", { command: "a" + ticks + "b" })).not.toContain("a" + ticks + "b");
  });
});

describe("ReplyParts 详细模式（全量保留·旧断言版）", () => {
  it("详细模式追加顺序不变", async () => {
    const seen: string[] = [];
    const sink = {
      render: async () => {},
      append: async (t: string) => {
        seen.push(t);
      },
    };
    const parts = new ReplyParts(sink, () => false);
    await parts.appendText("文本1");
    await parts.appendTool("动作1");
    await parts.appendText("文本2");
    expect(parts.composeFinal()).toBe("文本1动作1文本2");
  });
});
