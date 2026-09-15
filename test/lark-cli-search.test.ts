import { describe, expect, it } from "vitest";
import { parseSearchUserOutput } from "../src/feishu/lark-cli-search.ts";

/** 真实命令输出（lark-cli contact +search-user --user-ids ou_x --as user）的形状 */
const SAMPLE = JSON.stringify({
  ok: true,
  identity: "user",
  data: {
    users: [
      {
        open_id: "ou_0xx",
        localized_name: "张三",
        email: "",
        enterprise_email: "zhangsan@example.com",
        is_activated: true,
        is_cross_tenant: false,
        p2p_chat_id: "oc_x",
        has_chatted: true,
        department: "自动驾驶研发部-系统工程交付部-基础功能部",
        chat_recency_hint: "",
        match_segments: [],
      },
    ],
  },
});

describe("parseSearchUserOutput（用户态搜索结果解析）", () => {
  it("标准 JSON 输出：姓名 + 现成中文部门路径", () => {
    const profile = parseSearchUserOutput(SAMPLE);
    expect(profile?.name).toBe("张三");
    expect(profile?.department_name).toEqual(["自动驾驶研发部-系统工程交付部-基础功能部"]);
  });

  it("输出夹杂非 JSON 提示行时仍可解析（取最外层大括号）", () => {
    const noisy = `notice: something\n${SAMPLE}\ndone.`;
    expect(parseSearchUserOutput(noisy)?.name).toBe("张三");
  });

  it("users 为对象形式时取第一个值；ok:false 视为未命中", () => {
    const objectForm = JSON.stringify({
      ok: true,
      data: { users: { ou_0xx: { localized_name: "李四", department: "质量部" } } },
    });
    expect(parseSearchUserOutput(objectForm)?.name).toBe("李四");
    expect(parseSearchUserOutput(JSON.stringify({ ok: false, data: { users: [] } }))).toBeUndefined();
  });

  it("无姓名无部门 → 未命中（undefined）", () => {
    expect(parseSearchUserOutput(JSON.stringify({ ok: true, data: { users: [{ open_id: "ou_x" }] } }))).toBeUndefined();
    expect(parseSearchUserOutput("not json at all")).toBeUndefined();
  });
});
