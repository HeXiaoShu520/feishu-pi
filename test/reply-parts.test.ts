import { describe, expect, it } from "vitest";
import { formatStatsLine, formatToolCall, ReplyParts, type ReplyPartsSink } from "../src/feishu/reply-parts.ts";

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
    await parts.appendTool("> ⚙ 正在调用 **bash**：`ls`");
    await parts.appendText("第二段正文");

    // 最后一次 render 只含新正文段（旧内容已回收）
    const lastRender = calls.filter((c) => c.op === "render").pop();
    expect(lastRender).toEqual({ op: "render", text: "第二段正文" });
  });

  it("工具段只留当前一个：新工具出现时上一个就地置空", async () => {
    const { calls, sink } = makeSink();
    const parts = new ReplyParts(sink, () => true);

    await parts.appendTool("> ⚙ 工具一");
    await parts.appendTool("> ⚙ 工具二");

    const lastRender = calls.filter((c) => c.op === "render").pop();
    expect(lastRender?.text).toBe("> ⚙ 工具二");
    expect(lastRender?.text).not.toContain("工具一");
  });

  it("composeFinal：取最后一个工具段之后的正文；无尾段时退回全部非工具段", async () => {
    const { sink } = makeSink();
    const parts = new ReplyParts(sink, () => true);

    await parts.appendText("开头");
    await parts.appendTool("> ⚙ 工具");
    await parts.appendText("结论 A");
    await parts.appendText("结论 A 完整版");
    expect(parts.composeFinal()).toBe("结论 A 完整版");

    // 工具后无正文：退回非工具段（保留"开头"，工具段不计入）
    const { sink: sink2 } = makeSink();
    const parts2 = new ReplyParts(sink2, () => true);
    await parts2.appendText("开头");
    await parts2.appendTool("> ⚙ 工具");
    expect(parts2.composeFinal()).toBe("开头");
  });

  it("composeFinal：多轮正文+工具后以工具段结尾 → 用最近一次正文兜底（回收置空不丢内容）", async () => {
    const { sink } = makeSink();
    const parts = new ReplyParts(sink, () => true);

    // 真实时序：每轮"先说一段话 → 调一个工具"，最后以工具段结束。
    // 精简回收会把所有旧正文段置空，tail 与非工具段拼接都为空串——
    // 此时必须用最近一次正文全量兜底（修复前返回空串，用户收到空白卡）。
    await parts.appendText("我先看看现在的状态。");
    await parts.appendTool("> ⚙ 正在调用 **bash**：`ls`");
    await parts.appendText("查到了，我来整理一下。");
    await parts.appendTool("> ⚙ 正在调用 **bash**：`cat result.md`");
    expect(parts.composeFinal()).toBe("查到了，我来整理一下。");
  });

  it("精简显示语义：文字1 → 工具1 → 工具2 过程中文字1 保留，工具只替换工具", async () => {
    const { calls, sink } = makeSink();
    const parts = new ReplyParts(sink, () => true);

    await parts.appendText("文字1");
    await parts.appendTool("> ⚙ 工具一");
    await parts.appendTool("> ⚙ 工具二");
    // 工具二出现时：文字1 保留，工具一被工具二替换
    const lastRender = calls.filter((c) => c.op === "render").pop();
    expect(lastRender).toEqual({ op: "render", text: "文字1> ⚙ 工具二" });

    // 遇到文字2 才整体刷新：文字1 与工具全部消失
    await parts.appendText("文字2");
    const render2 = calls.filter((c) => c.op === "render").pop();
    expect(render2).toEqual({ op: "render", text: "文字2" });
    expect(parts.composeFinal()).toBe("文字2");
  });

  it("精简显示语义：文字1 → 工具1 → 文字2（无更多工具）→ 工具2，文字1 保留到文字2 出现", async () => {
    const { calls, sink } = makeSink();
    const parts = new ReplyParts(sink, () => true);

    await parts.appendText("文字1");
    await parts.appendTool("> ⚙ 工具一");
    await parts.appendText("文字2");
    await parts.appendTool("> ⚙ 工具二");
    // 工具二出现时：文字2 保留（文字1 已在文字2 出现时刷新）
    const lastRender = calls.filter((c) => c.op === "render").pop();
    expect(lastRender).toEqual({ op: "render", text: "文字2> ⚙ 工具二" });
    expect(parts.composeFinal()).toBe("文字2");
  });
});

describe("ReplyParts 详细模式（全量保留）", () => {
  it("不做回收：全部内容按序追加", async () => {
    const { calls, sink } = makeSink();
    const parts = new ReplyParts(sink, () => false);

    await parts.appendText("第一段");
    await parts.appendTool("> ⚙ 工具");
    await parts.appendText("第二段");

    expect(parts.composeFinal()).toBe("第一段> ⚙ 工具第二段");
    // 详细模式新段走 append，不重绘
    expect(calls.every((c) => c.op === "append")).toBe(true);
  });
});

describe("formatToolCall 工具行格式化（单行紧凑式）", () => {
  it("bash：工具名加粗 + 命令行内代码，同一行", () => {
    expect(formatToolCall("bash", { command: "git status" })).toBe("**bash** `git status`");
  });

  it("read/write/edit：目标路径跟在工具名后", () => {
    expect(formatToolCall("read", { path: "docs/a.md" })).toBe("**read** `docs/a.md`");
    expect(formatToolCall("edit", { file_path: "src/x.ts" })).toBe("**edit** `src/x.ts`");
  });

  it("未知字段回退整包参数 JSON；超长截断；反引号/换行折叠不破坏行内代码", () => {
    expect(formatToolCall("my_tool", { foo: "bar" })).toContain('"foo"');
    const long = "x".repeat(400);
    const line = formatToolCall("bash", { command: long });
    expect(line.length).toBeLessThan(420);
    expect(line.endsWith("…`")).toBe(true);
    const fenced = formatToolCall("bash", { command: "a```b" });
    expect(fenced).not.toContain("a```b");
    // 多行命令折叠为单行
    expect(formatToolCall("bash", { command: "line1\nline2" })).toBe("**bash** `line1 line2`");
  });
});

describe("formatStatsLine 统计小字", () => {
  it("完整字段：模型 · token（新增） · ctx · 费用 · 耗时 · 别名", () => {
    const line = formatStatsLine({
      modelName: "claude-sonnet-4-6",
      stats: { tokens: { total: 24_600 }, cost: 0.0884, sessionId: "aaaaaaaa-bbbb-cccc" },
      baselineTotalTokens: 6_900,
      elapsedMs: 6_700,
      contextPercent: 2.4,
    });
    expect(line).toMatch(/^claude-sonnet-4-6 · 24\.6K（新增 17\.7K） · ctx ~2% · \$0\.0884 · 6\.7s · /);
  });

  it("无统计返回 undefined；缺字段自动省略（无会话 ID 时别名显示 未知）", () => {
    expect(formatStatsLine({ elapsedMs: 1000 })).toBeUndefined();
    const line = formatStatsLine({ modelName: "m", stats: { tokens: { total: 1000 } }, elapsedMs: 2_000 });
    expect(line).toBe("m · 1.0K（新增 1.0K） · 2.0s · 未知");
  });
});
