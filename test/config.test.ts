import { describe, expect, it, vi } from "vitest";
import { loadConfig, parseGroupMembership } from "../src/config.ts";

const baseEnv = {
  FEISHU_APP_ID: "cli_x",
  FEISHU_APP_SECRET: "s",
  FEISHU_PI_MODEL_API_KEY: "k",
};

describe("loadConfig 模型统计小字开关", () => {
  it("未配置 → 默认显示统计小字", () => {
    expect(loadConfig(baseEnv).showModelStats).toBe(true);
  });

  it("FEISHU_SHOW_MODEL_STATS：0/false/off 关闭；1/true/on 开启", () => {
    expect(loadConfig({ ...baseEnv, FEISHU_SHOW_MODEL_STATS: "0" }).showModelStats).toBe(false);
    expect(loadConfig({ ...baseEnv, FEISHU_SHOW_MODEL_STATS: "false" }).showModelStats).toBe(false);
    expect(loadConfig({ ...baseEnv, FEISHU_SHOW_MODEL_STATS: "off" }).showModelStats).toBe(false);
    expect(loadConfig({ ...baseEnv, FEISHU_SHOW_MODEL_STATS: "1" }).showModelStats).toBe(true);
    expect(loadConfig({ ...baseEnv, FEISHU_SHOW_MODEL_STATS: "true" }).showModelStats).toBe(true);
    expect(loadConfig({ ...baseEnv, FEISHU_SHOW_MODEL_STATS: "ON" }).showModelStats).toBe(true);
  });

  it("组员宏：FEISHU_PI_GROUP_<纯数字> 映射为 group_<数字>；非数字组名转小写", () => {
    const config = loadConfig({ ...baseEnv, FEISHU_PI_GROUP_1: "李雷", FEISHU_PI_GROUP_VIP: "韩梅梅" });
    expect(config.groupMembership["group_1"]).toEqual(["李雷"]);
    expect(config.groupMembership["vip"]).toEqual(["韩梅梅"]);
  });
});

describe("parseGroupMembership（FEISHU_PI_GROUP 配置语义）", () => {
  const warn = vi.fn();
  it("FEISHU_PI_GROUP（无后缀）映射到主团队组 group；FEISHU_PI_GROUP_1 映射到 group_1（两者是不同组）", () => {
    const groups = parseGroupMembership({ FEISHU_PI_GROUP: "李雷, 韩梅梅", FEISHU_PI_GROUP_1: "王强" });
    expect(groups["group"]).toEqual(["李雷", "韩梅梅"]);
    expect(groups["group_1"]).toEqual(["王强"]);
  });

  it("纯数字后缀映射 group_<N>；自定义组名转小写", () => {
    const groups = parseGroupMembership({ FEISHU_PI_GROUP_2: "甲", FEISHU_PI_GROUP_VIP: "乙" });
    expect(groups["group_2"]).toEqual(["甲"]);
    expect(groups["vip"]).toEqual(["乙"]);
  });

  it("FEISHU_PI_GROUP_USER1 不再是特殊键：按自定义组名 user1 处理", () => {
    const groups = parseGroupMembership({ FEISHU_PI_GROUP_USER1: "李雷" });
    expect(groups["user1"]).toEqual(["李雷"]);
    expect(groups["group_1"]).toBeUndefined();
  });

  it("任意组名一律走通用规则（admin 也不特判）", () => {
    const groups = parseGroupMembership({ FEISHU_PI_GROUP_ADMIN: "张三" });
    expect(groups["admin"]).toEqual(["张三"]);
  });
});

describe("deriveModelProvider（供应商由模型名推断）", () => {
  it("带 claude → anthropic；带 deepseek → deepseek；其余 → openai", () => {
    expect(loadConfig({ ...baseEnv, FEISHU_PI_MODEL_NAME: "claude-sonnet-4-6" }).modelProvider).toBe("anthropic");
    expect(loadConfig({ ...baseEnv, FEISHU_PI_MODEL_NAME: "deepseek-v4-flash" }).modelProvider).toBe("deepseek");
    expect(loadConfig({ ...baseEnv, FEISHU_PI_MODEL_NAME: "deepseek-v4.1-flash" }).modelProvider).toBe("deepseek");
    expect(loadConfig({ ...baseEnv, FEISHU_PI_MODEL_NAME: "gpt-4o" }).modelProvider).toBe("openai");
    expect(loadConfig({ ...baseEnv, FEISHU_PI_MODEL_NAME: "qwen-max" }).modelProvider).toBe("openai");
  });

  it("FEISHU_PI_MODEL_PROVIDER 环境变量已废弃：不再影响推断结果", () => {
    const env = { ...baseEnv, FEISHU_PI_MODEL_PROVIDER: "deepseek", FEISHU_PI_MODEL_NAME: "claude-sonnet-4-6" };
    expect(loadConfig(env).modelProvider).toBe("anthropic");
  });
});
