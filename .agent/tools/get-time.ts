import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * 获取当前时间的工具
 */
export const getTimeTool: ToolDefinition = {
  name: "get_current_time",
  description: "获取当前日期和时间",
  permission: "default",
  input_schema: {
    type: "object",
    properties: {},
  },
  execute: async () => {
    const now = new Date();
    const time = now.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false
    });
    return {
      content: [{ type: "text", text: time }],
      details: {}
    };
  },
};
