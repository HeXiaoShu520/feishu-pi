import { describe, expect, it } from "vitest";
import { GroupActivity } from "../src/feishu/group-activity.ts";

describe("群聊最近消息缓冲", () => {
  it("记录消息与最后活动时间", () => {
    const activity = new GroupActivity();
    activity.observe("g1", "哥哥", "今天累死了", 1000);
    const snapshot = activity.snapshot("g1");
    expect(snapshot?.lastAt).toBe(1000);
    expect(snapshot?.messages[0]).toMatchObject({ name: "哥哥", text: "今天累死了" });
  });

  it("纯图片或系统标记不占位置", () => {
    const activity = new GroupActivity();
    activity.observe("g1", "A", "[图片] 已保存到: a.png", 1000);
    activity.observe("g1", "A", "[表情包]", 1001);
    expect(activity.snapshot("g1")?.messages).toHaveLength(0);
    expect(activity.snapshot("g1")?.lastAt).toBe(1001);
  });

  it("清掉 @ 标签并保留最近 20 条", () => {
    const activity = new GroupActivity();
    for (let i = 0; i < 25; i += 1) activity.observe("g1", "A", `<at id="ou_x"></at> 第 ${i} 条`, i);
    const snapshot = activity.snapshot("g1");
    expect(snapshot?.messages).toHaveLength(20);
    expect(snapshot?.messages.at(-1)?.text).toBe("第 24 条");
  });

  it("自己主动发言也推进最后活动时间", () => {
    const activity = new GroupActivity();
    activity.observe("g1", "A", "聊聊", 1000);
    activity.observeSelf("g1", "那就聊聊", 2000);
    expect(activity.snapshot("g1")?.lastAt).toBe(2000);
  });

  it("同毫秒的纯图回复不把群友的上一句误标为机器人", () => {
    const activity = new GroupActivity();
    activity.observe("g", "群友", "大家看看", 1000);
    activity.observeSelf("g", "[图片]", 1000);
    const messages = activity.snapshot("g")!.messages;
    expect(messages[0].self).toBeUndefined();
    expect(messages[1]).toMatchObject({ name: "大肥鱼", self: true, text: "[图片]" });
  });
});
