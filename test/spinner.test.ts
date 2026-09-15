import { describe, expect, it } from "vitest";
import { SPINNER_STYLES, Spinner, randomFrames } from "../src/feishu/spinner.ts";
import { toolIcon } from "../src/feishu/reply-parts.ts";

describe("Spinner（样式注册表与帧循环）", () => {
  it("样式注册表：六种启用样式（braille/halfcircle/quarter/cross/triangle/dots）", () => {
    expect(Object.keys(SPINNER_STYLES).sort()).toEqual(
      ["braille", "cross", "dots", "halfcircle", "quarter", "triangle"],
    );
    // dots 样式即"点从 1 个到 3 个"
    expect(SPINNER_STYLES.dots).toEqual(["·", "··", "···"]);
  });

  it("randomFrames 每次返回某一种启用样式的完整副本", () => {
    for (let i = 0; i < 30; i++) {
      const frames = randomFrames();
      expect(Object.values(SPINNER_STYLES).some((style) => style.join() === frames.join())).toBe(true);
    }
  });

  it("Spinner 在锁定的样式内逐帧循环；withPrefix 换前缀不换样式", () => {
    const frames = ["·", "··", "···"];
    const spinner = new Spinner("⚙ bash", frames);
    expect(spinner.next()).toBe("⚙ bash ·");
    expect(spinner.next()).toBe("⚙ bash ··");
    expect(spinner.next()).toBe("⚙ bash ···");
    // 循环回到首帧
    expect(spinner.next()).toBe("⚙ bash ·");

    spinner.withPrefix("📖 read");
    expect(spinner.next()).toBe("📖 read ··"); // 帧序延续，样式不变
  });

  it("默认构造：随机样式 + 随机思考前缀；next 输出前缀+帧", () => {
    const spinner = new Spinner();
    const text = spinner.next();
    expect(text.length).toBeGreaterThan(1);
    expect(text).toContain(" ");
  });
});

describe("toolIcon（工具类型图标，固定不动画）", () => {
  it("bash=⚙ read=📖 write=📝 edit=✏️ 其余=🔧", () => {
    expect(toolIcon("bash")).toBe("⚙");
    expect(toolIcon("read")).toBe("📖");
    expect(toolIcon("write")).toBe("📝");
    expect(toolIcon("edit")).toBe("✏️");
    expect(toolIcon("query_skill_usage")).toBe("🔧");
    expect(toolIcon("anything_else")).toBe("🔧");
  });
});
