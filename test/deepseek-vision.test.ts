import { describe, expect, it } from "vitest";
import { getModel } from "@earendil-works/pi-ai/compat";

describe("DeepSeek Flash model registration", () => {
  it("uses the official image-capable Flash model and DeepSeek protocol", () => {
    const model = getModel("deepseek", "deepseek-flash");
    expect(model).toBeDefined();
    expect(model?.input).toContain("image");
    expect(model?.api).toBe("openai-completions");
    expect(model?.baseUrl).toBe("https://api.deepseek.com");
  });
});
