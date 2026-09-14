import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

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

  it("组员宏：FEISHU_GROUP_<纯数字> 映射为 group_<数字>；非数字组名转小写", () => {
    const config = loadConfig({ ...baseEnv, FEISHU_GROUP_1: "李雷", FEISHU_GROUP_VIP: "韩梅梅" });
    expect(config.groupMembership["group_1"]).toEqual(["李雷"]);
    expect(config.groupMembership["vip"]).toEqual(["韩梅梅"]);
  });
});
