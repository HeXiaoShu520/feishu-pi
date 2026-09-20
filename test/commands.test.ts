import { describe, expect, it, vi } from "vitest";
import type { FeishuInboundMessage } from "../src/feishu/types.ts";
import { RestartCommand } from "../src/feishu/commands.ts";

function message(isAdmin: boolean): FeishuInboundMessage {
  return { context: { isAdmin } } as unknown as FeishuInboundMessage;
}

describe("RestartCommand", () => {
  it("非管理员只能收到拒绝卡片", async () => {
    const trigger = vi.fn();
    const result = await new RestartCommand(trigger).execute(message(false));

    expect(JSON.stringify(result?.card)).toContain("只有管理员");
    expect(result?.afterSend).toBeUndefined();
    expect(trigger).not.toHaveBeenCalled();
  });

  it("管理员在回执发送后触发重启回调", async () => {
    const trigger = vi.fn();
    const result = await new RestartCommand(trigger).execute(message(true));

    expect(JSON.stringify(result?.card)).toContain("重启开发服务");
    expect(trigger).not.toHaveBeenCalled();
    result?.afterSend?.();
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});
