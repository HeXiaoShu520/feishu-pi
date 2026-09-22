import { describe, expect, it, vi } from "vitest";
import { sendAdminLifecycleNotice } from "../src/feishu/admin-lifecycle-notice.ts";

describe("sendAdminLifecycleNotice", () => {
  it("以管理员 open_id 发送生命周期通知", async () => {
    const send = vi.fn(async () => {});
    await sendAdminLifecycleNotice(send, "ou_admin", "🟢 mini-claw 已上线", 100);
    expect(send).toHaveBeenCalledWith("ou_admin", "🟢 mini-claw 已上线");
  });

  it("未配置管理员时跳过发送", async () => {
    const send = vi.fn(async () => {});
    await sendAdminLifecycleNotice(send, undefined, "🟢 mini-claw 已上线", 100);
    expect(send).not.toHaveBeenCalled();
  });
});
