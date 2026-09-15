import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { buildAddons, buildQrLink } from "../src/feishu/setup-wizard.ts";

describe("buildQrLink（扫码链接组装，对齐官方 SDK 线协议）", () => {
  it("追加 from/source/tp 与 addons；addons 可解出预置权限清单；原有参数保留", () => {
    const addons = buildAddons();
    const link = buildQrLink("https://accounts.feishu.cn/activate?user_code=ABC&org=dev", { addons });
    const url = new URL(link);
    expect(url.searchParams.get("from")).toBe("sdk");
    expect(url.searchParams.get("source")).toBe("node-sdk/feishu-pi");
    expect(url.searchParams.get("tp")).toBe("sdk");

    const encoded = url.searchParams.get("addons") ?? "";
    expect(encoded).not.toBe("");
    // base64url → base64 → gunzip → JSON（与 SDK encodeAddons 互逆）
    const json = gunzipSync(Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64")).toString("utf8");
    const parsed = JSON.parse(json) as {
      scopes?: { tenant?: string[] };
      events?: { items?: { tenant?: string[] } };
      callbacks?: { items?: string[] };
    };
    expect(parsed.scopes?.tenant).toContain("im:message");
    expect(parsed.scopes?.tenant).toContain("contact:user.base:readonly");
    expect(parsed.events?.items?.tenant).toEqual(["im.message.receive_v1"]);
    expect(parsed.callbacks?.items).toEqual(["card.action.trigger"]);

    expect(url.searchParams.get("user_code")).toBe("ABC");
  });

  it("不传 addons 不追加该参数；existingAppId → clientID（更新已有应用模式）", () => {
    const plain = new URL(buildQrLink("https://accounts.feishu.cn/activate?u=1"));
    expect(plain.searchParams.get("addons")).toBeNull();
    expect(plain.searchParams.get("clientID")).toBeNull();

    const update = new URL(buildQrLink("https://accounts.feishu.cn/activate?u=1", { existingAppId: "cli_x" }));
    expect(update.searchParams.get("clientID")).toBe("cli_x");
  });

  it("预置权限不含需管理员审核的部门路径 scope（部门走 lark-cli 用户态搜索）", () => {
    const tenant = buildAddons().scopes as { tenant?: string[] };
    expect(tenant.tenant).not.toContain("contact:user.department:readonly");
    expect(tenant.tenant).not.toContain("contact:user.department_path:readonly");
  });
});
