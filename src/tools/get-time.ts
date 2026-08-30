import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * 获取当前时间的工具
 */
export const getTimeTool: ToolDefinition = {
  name: "get_current_time",
  description: "获取当前日期和时间，支持指定时区",
  permission: "default", // default | team | admin
  input_schema: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "时区，例如 'Asia/Shanghai', 'America/New_York'。默认为 'Asia/Shanghai'",
      },
      format: {
        type: "string",
        description: "返回格式：'full'(完整), 'date'(仅日期), 'time'(仅时间)。默认 'full'",
        enum: ["full", "date", "time"],
      },
    },
  },
  execute: async (toolCallId: string, params: unknown, signal: AbortSignal | undefined) => {
    const input = params as { timezone?: string; format?: string };
    const timezone = input.timezone || "Asia/Shanghai";
    const format = input.format || "full";

    try {
      const now = new Date();
      const options: Intl.DateTimeFormatOptions = {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      };

      const formatter = new Intl.DateTimeFormat("zh-CN", options);
      const parts = formatter.formatToParts(now);

      const year = parts.find((p) => p.type === "year")?.value;
      const month = parts.find((p) => p.type === "month")?.value;
      const day = parts.find((p) => p.type === "day")?.value;
      const hour = parts.find((p) => p.type === "hour")?.value;
      const minute = parts.find((p) => p.type === "minute")?.value;
      const second = parts.find((p) => p.type === "second")?.value;

      const dateStr = `${year}-${month}-${day}`;
      const timeStr = `${hour}:${minute}:${second}`;

      let result = "";
      if (format === "date") {
        result = dateStr;
      } else if (format === "time") {
        result = timeStr;
      } else {
        result = `${dateStr} ${timeStr}`;
      }

      return `当前时间（${timezone}）：${result}`;
    } catch (error) {
      return `获取时间失败：${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
