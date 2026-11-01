import { defineTool } from "../../src/tools/sdk.ts";

export default defineTool({
  name: "local_time",
  description:
    "读取电脑当前时间和时区；需要准确的当前时间时调用，不依赖模型记忆。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: () => ({
    iso: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    local: new Date().toLocaleString("zh-CN"),
  }),
});
