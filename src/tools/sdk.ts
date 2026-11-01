import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateTool } from "./module-loader.ts";
import { textResult } from "./result.ts";

export interface LocalToolContext {
  cwd: string;
  signal?: AbortSignal;
}
export interface LocalToolOptions<Params> {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  risk?: "high";
  executionMode?: "sequential" | "parallel";
  execute(
    params: Params,
    context: LocalToolContext,
  ): unknown | Promise<unknown>;
}
/** Plain results become bounded text; use native definitions for images and streaming. */
export function defineTool<Params = Record<string, unknown>>(
  options: LocalToolOptions<Params>,
): ToolDefinition & { risk?: "high" } {
  return validateTool(
    {
      ...options,
      execute: async (
        _id: string,
        params: Params,
        signal: AbortSignal | undefined,
        _update: unknown,
        context: { cwd: string },
      ) => {
        signal?.throwIfAborted();
        const result = await options.execute(params, {
          cwd: context.cwd,
          signal,
        });
        signal?.throwIfAborted();
        return textResult(result ?? "完成");
      },
    },
    options.name,
  );
}
