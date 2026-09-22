import { describe, expect, it } from "vitest";
import { isValidMiniPetUserOpenId, loadConfig, parseGroupMembership } from "../src/config.ts";

const baseEnv = { FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "s", FEISHU_PI_MODEL_API_KEY: "k" };

describe("loadConfig", () => {
  it("保留稳定的资源和 MiniPet 配置", () => {
    const config = loadConfig({ ...baseEnv, MINIPET_USER_OPEN_ID: "mini_user", FEISHU_PI_MAX_RESOURCE_MB: "8" });
    expect(config.showModelStats).toBe(true);
    expect(config.maxResourceBytes).toBe(8 * 1024 * 1024);
    expect(config.miniPetUserOpenId).toBe("mini_user");
    expect(isValidMiniPetUserOpenId("ou_c34b02e41beb83e64f2ca8efaaf9299d")).toBe(true);
    expect(isValidMiniPetUserOpenId("minipet_user")).toBe(false);
  });

  it("只解析唯一团队 FEISHU_PI_GROUP，忽略历史上的第二团队变量", () => {
    const groups = parseGroupMembership({
      FEISHU_PI_GROUP: "李雷, 韩梅梅,李雷",
      FEISHU_PI_GROUP_1: "不应进入团队",
      FEISHU_PI_GROUP_VIP: "不应进入团队",
    });
    expect(groups).toEqual({ group: ["李雷", "韩梅梅"] });
    expect(parseGroupMembership({ FEISHU_PI_GROUP_1: "李雷" })).toEqual({});
  });

  it("模型供应商仍由模型名推断", () => {
    expect(loadConfig({ ...baseEnv, FEISHU_PI_MODEL_NAME: "claude-sonnet-4-6" }).modelProvider).toBe("anthropic");
    expect(loadConfig({ ...baseEnv, FEISHU_PI_MODEL_NAME: "deepseek-v4-flash" }).modelProvider).toBe("deepseek");
    expect(loadConfig({ ...baseEnv, FEISHU_PI_MODEL_NAME: "gpt-4o" }).modelProvider).toBe("openai");
  });
});
