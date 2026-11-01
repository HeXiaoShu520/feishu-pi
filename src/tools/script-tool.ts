import { fileURLToPath } from "node:url";
import { extname, resolve } from "node:path";
import { defineTool, type LocalToolOptions } from "./sdk.ts";
import { runProcess } from "../process/runner.ts";

export type ScriptToolOptions = Omit<
  LocalToolOptions<Record<string, unknown>>,
  "execute"
> & { script: string | URL; timeoutMs?: number };
/** Scripts read JSON stdin and return text or JSON stdout. No shell interpolation. */
export function defineScriptTool(options: ScriptToolOptions) {
  const { script, timeoutMs = 30_000, ...metadata } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    throw new Error(`${options.name}: timeoutMs 必须在 1 到 600000 之间`);
  return defineTool({
    ...metadata,
    execute: async (params, context) => {
      const path =
        script instanceof URL
          ? fileURLToPath(script)
          : resolve(context.cwd, script);
      const ext = extname(path).toLowerCase();
      if (![".ts", ".js", ".mjs"].includes(ext))
        throw new Error("脚本只支持 .ts/.js/.mjs");
      const result = await runProcess(
        process.execPath,
        [...(ext === ".ts" ? ["--import", "tsx"] : []), path],
        {
          cwd: context.cwd,
          input: JSON.stringify(params),
          signal: context.signal,
          timeoutMs,
        },
      );
      if (result.exitCode !== 0)
        throw new Error(
          `脚本退出码 ${result.exitCode}: ${result.stderr || "无错误输出"}`,
        );
      if (result.truncated)
        throw new Error("脚本输出超过上限，请将大结果写入文件并返回路径");
      const output = result.stdout.trim();
      if (!output) return "脚本执行完成，无输出";
      try {
        return JSON.parse(output) as unknown;
      } catch {
        return output;
      }
    },
  });
}
