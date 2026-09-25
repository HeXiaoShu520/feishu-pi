import { describe, expect, it } from "vitest";
import { isValidMiniPetUserOpenId, loadConfig } from "../src/config.ts";

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

  it("不再从环境变量读取团队成员名单", () => {
    const config = loadConfig({ ...baseEnv, FEISHU_PI_GROUP: "李雷,韩梅梅" });
    expect("groupMembership" in config).toBe(false);
  });

  it("模型供应商仍由模型名推断", () => {
    expect(loadConfig({ ...baseEnv, FEISHU_PI_MODEL_NAME: "claude-sonnet-4-6" }).modelProvider).toBe("anthropic");
    expect(loadConfig({ ...baseEnv, FEISHU_PI_MODEL_NAME: "deepseek-v4-flash" }).modelProvider).toBe("deepseek");
    expect(loadConfig({ ...baseEnv, FEISHU_PI_MODEL_NAME: "gpt-4o" }).modelProvider).toBe("openai");
  });

  it("服务上下线通知可由环境变量覆盖，并支持换行和退出信号占位符", () => {
    const config = loadConfig({
      ...baseEnv,
      FEISHU_PI_ONLINE_NOTICE: "上线\\n准备完毕",
      FEISHU_PI_OFFLINE_NOTICE: "收到 {signal}，下线",
    });
    expect(config.onlineNotice).toBe("上线\n准备完毕");
    expect(config.offlineNotice.replaceAll("{signal}", "SIGTERM")).toBe("收到 SIGTERM，下线");
  });
});
