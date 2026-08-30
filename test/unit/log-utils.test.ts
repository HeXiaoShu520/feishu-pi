import { describe, it, expect } from "vitest";
import { formatLogText } from "../../src/feishu/log-utils.ts";

describe("log-utils", () => {
  describe("formatLogText", () => {
    it("应该去除换行符", () => {
      const input = "第一行\n第二行\r\n第三行";
      const output = formatLogText(input);
      expect(output).toBe("第一行 第二行 第三行");
    });

    it("应该限制长度", () => {
      const input = "a".repeat(150);
      const output = formatLogText(input, 100);
      expect(output).toBe("a".repeat(100) + "...");
    });

    it("应该处理短文本", () => {
      const input = "短文本";
      const output = formatLogText(input);
      expect(output).toBe("短文本");
    });

    it("应该处理空文本", () => {
      const input = "";
      const output = formatLogText(input);
      expect(output).toBe("");
    });

    it("应该去除首尾空白", () => {
      const input = "  有空白  \n\n  ";
      const output = formatLogText(input);
      expect(output).toBe("有空白");
    });
  });
});

describe("image data conversion", () => {
  it("Uint8Array 应该能正确转换为 base64", () => {
    // 模拟图片数据
    const mockImageData = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG header

    // 转换为 base64（模拟 feishu-pi-runtime.ts 的逻辑）
    const base64 = Buffer.from(mockImageData).toString("base64");

    expect(base64).toBe("/9j/4A=="); // JPEG header 的 base64
    expect(typeof base64).toBe("string");
  });

  it("空 Uint8Array 应该能处理", () => {
    const emptyData = new Uint8Array([]);
    const base64 = Buffer.from(emptyData).toString("base64");
    expect(base64).toBe("");
  });
});
