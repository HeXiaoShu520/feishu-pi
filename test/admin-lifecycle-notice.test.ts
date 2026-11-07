import { describe, expect, it, vi } from "vitest";
import { sendOwnerLifecycleNotice } from "../src/feishu/owner-lifecycle-notice.ts";

describe("sendOwnerLifecycleNotice", () => {
  it("以管理员 open_id 发送生命周期通知", async () => {
    const send = vi.fn(async () => {});
    await sendOwnerLifecycleNotice(send, "ou_admin", "🟢 feishu-pi 已上线", 100);
    expect(send).toHaveBeenCalledWith("ou_admin", "🟢 feishu-pi 已上线");
  });

  it("未配置管理员时跳过发送", async () => {
    const send = vi.fn(async () => {});
    await sendOwnerLifecycleNotice(send, undefined, "🟢 feishu-pi 已上线", 100);
    expect(send).not.toHaveBeenCalled();
  });
});
