import { describe, expect, it } from "vitest";
import { historySearchTopic } from "../src/assistant/memory-query.ts";

describe("历史话题问法", () => {
  it.each([
    ["我们之前聊过蓝鲸吗？", "蓝鲸"],
    ["你还记得我之前跟你说过的猫吗？", "猫"],
    ["我以前向你提过樱桃吗？", "樱桃"],
    ["你记得我们讨论过关于迁徙的事吗？", "迁徙"],
    ["我们上次聊过什么？", ""],
    ["蓝鲸是什么？", ""],
  ])("%s → %s", (query, topic) => { expect(historySearchTopic(query)).toBe(topic); });
});
