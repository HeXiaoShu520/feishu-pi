import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const baseEnv = { FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "s", FEISHU_PI_MODEL_API_KEY: "k" };

describe("loadConfig", () => {
  it("保留稳定的资源配置", () => {
    const config = loadConfig({ ...baseEnv, FEISHU_PI_MAX_RESOURCE_MB: "8" });
    // 统计小字默认不显示（像个人说话），显式开启才出现
    expect(config.showModelStats).toBe(false);
    expect(loadConfig({ ...baseEnv, FEISHU_SHOW_MODEL_STATS: "1" }).showModelStats).toBe(true);
    // 回复文字 emoji 默认允许，可显式关闭
    expect(config.replyEmoji).toBe(true);
    expect(loadConfig({ ...baseEnv, FEISHU_PI_REPLY_EMOJI: "0" }).replyEmoji).toBe(false);
    // 群聊主动接话默认开启，可显式关闭
    expect(config.groupChime).toBe(true);
    expect(loadConfig({ ...baseEnv, FEISHU_PI_GROUP_CHIME: "0" }).groupChime).toBe(false);
    expect(config.maxResourceBytes).toBe(8 * 1024 * 1024);
  });

  it("B站自动化服务默认不加载，可显式开启或关闭", () => {
    expect(loadConfig(baseEnv).biliAutoAvailable).toBe(false);
    expect(loadConfig({ ...baseEnv, FEISHU_BILI_AUTO_AVAILABLE: "true" }).biliAutoAvailable).toBe(true);
    expect(loadConfig({ ...baseEnv, FEISHU_BILI_AUTO_AVAILABLE: "false" }).biliAutoAvailable).toBe(false);
    expect(loadConfig(baseEnv).biliShareAvailable).toBe(false);
    expect(loadConfig({ ...baseEnv, FEISHU_BILI_SHARE_AVAILABLE: "true" }).biliShareAvailable).toBe(true);
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
