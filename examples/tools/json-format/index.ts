import { defineScriptTool } from "../../../src/tools/script-tool.ts";

export default defineScriptTool({
  name: "json_format",
  description:
    "校验并格式化一段 JSON 字符串，返回缩进后的文本。输入不是有效 JSON 时明确报错。",
  parameters: {
    type: "object",
    properties: { text: { type: "string", maxLength: 10_000 } },
    required: ["text"],
    additionalProperties: false,
  },
  script: new URL("./run.ts", import.meta.url),
  timeoutMs: 10_000,
});
