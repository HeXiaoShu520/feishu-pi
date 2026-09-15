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

  it("组员宏：FEISHU_GROUP_<纯数字> 映射为 group_<数字>；非数字组名转小写", () => {
    const config = loadConfig({ ...baseEnv, FEISHU_GROUP_1: "李雷", FEISHU_GROUP_VIP: "韩梅梅" });
    expect(config.groupMembership["group_1"]).toEqual(["李雷"]);
    expect(config.groupMembership["vip"]).toEqual(["韩梅梅"]);
  });
});

describe("parseGroupMembership（FEISHU_GROUP 配置语义）", () => {
  const warn = vi.fn();
  it("FEISHU_GROUP（无后缀）与 FEISHU_GROUP_1 都映射到主团队组 group_1，成员合并去重", () => {
    const groups = parseGroupMembership({ FEISHU_GROUP: "李雷, 韩梅梅", FEISHU_GROUP_1: "韩梅梅,王强" }, warn);
    expect(groups["group_1"]).toEqual(["李雷", "韩梅梅", "王强"]);
  });

  it("纯数字后缀映射 group_<N>；自定义组名转小写", () => {
    const groups = parseGroupMembership({ FEISHU_GROUP_2: "甲", FEISHU_GROUP_VIP: "乙" }, warn);
    expect(groups["group_2"]).toEqual(["甲"]);
    expect(groups["vip"]).toEqual(["乙"]);
  });

  it("FEISHU_GROUP_USER1 不再是特殊键：按自定义组名 user1 处理", () => {
    const groups = parseGroupMembership({ FEISHU_GROUP_USER1: "李雷" }, warn);
    expect(groups["user1"]).toEqual(["李雷"]);
    expect(groups["group_1"]).toBeUndefined();
  });

  it("FEISHU_GROUP_ADMIN 已废弃：忽略并提示删除（不产生 admin 组）", () => {
    const groups = parseGroupMembership({ FEISHU_GROUP_ADMIN: "张三" }, warn);
    expect(groups["admin"]).toBeUndefined();
    expect(Object.keys(groups)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("FEISHU_GROUP_ADMIN 已废弃"));
  });
});
