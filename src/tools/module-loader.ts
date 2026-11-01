import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { pathToFileURL } from "node:url";

/** Validate definitions before a malformed contract reaches a model request. */
export function validateTool(value: unknown, file: string): ToolDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${file}: 工具必须导出对象`);
  const tool = value as Record<string, unknown>;
  if (
    typeof tool.name !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tool.name)
  )
    throw new Error(`${file}: name 必须是字母开头的工具名（最长 64 个字符）`);
  if (typeof tool.description !== "string" || !tool.description.trim())
    throw new Error(`${file}: 缺少 description`);
  if (typeof tool.execute !== "function")
    throw new Error(`${file}: execute 必须是函数`);
  if (
    !tool.parameters ||
    typeof tool.parameters !== "object" ||
    Array.isArray(tool.parameters) ||
    (tool.parameters as { type?: unknown }).type !== "object"
  )
    throw new Error(`${file}: parameters 必须是 object JSON Schema`);
  if (
    tool.label !== undefined &&
    (typeof tool.label !== "string" || !tool.label.trim())
  )
    throw new Error(`${file}: label 必须是非空字符串`);
  if (tool.risk !== undefined && tool.risk !== "high")
    throw new Error(`${file}: risk 只支持 high`);
  if (
    tool.executionMode !== undefined &&
    !["sequential", "parallel"].includes(String(tool.executionMode))
  )
    throw new Error(`${file}: executionMode 无效`);
  try {
    // A fresh compiler avoids cross-tool $id collisions hiding an invalid schema.
    new AjvJsonSchemaValidator().getValidator(
      tool.parameters as Parameters<AjvJsonSchemaValidator["getValidator"]>[0],
    );
  } catch (error) {
    throw new Error(
      `${file}: parameters schema 无效：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    ...tool,
    label: tool.label ?? tool.name,
  } as unknown as ToolDefinition;
}
/** Explicit exports avoid registering helper objects in the same module. */
export async function loadToolModule(file: string): Promise<ToolDefinition[]> {
  const module = (await import(pathToFileURL(file).href)) as Record<
    string,
    unknown
  >;
  const exported = module.default ?? module.tools ?? module.tool;
  if (exported === undefined)
    throw new Error(`${file}: 缺少 default、tool 或 tools 导出`);
  const tools = Array.isArray(exported) ? exported : [exported];
  if (!tools.length) throw new Error(`${file}: 导出的工具数组为空`);
  return tools.map((tool) => validateTool(tool, file));
}
