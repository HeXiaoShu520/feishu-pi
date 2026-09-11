import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FeishuPiTool } from "../runtime/types.ts";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { join, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../utils/logger.ts";

export const DEFAULT_BUILTIN_TOOLS = ["read", "write", "edit", "bash"] as const;

interface PythonToolMeta {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

// ---------- Python 检测与元数据解析 ----------

let _pythonCmd: string | null = null;

/** 探测可用的 Python 命令并缓存 */
function detectPython(): string {
  if (_pythonCmd) return _pythonCmd;
  const candidates = process.platform === "win32"
    ? ["python", "py", "python3"]
    : ["python3", "python"];
  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ["--version"], { stdio: "pipe", windowsHide: true });
      _pythonCmd = cmd;
      logger.info(`[Registry] 检测到 Python 命令: ${cmd}`);
      return cmd;
    } catch {
      continue;
    }
  }
  _pythonCmd = "python";
  logger.warn("[Registry] 未检测到 Python，尝试默认 python 命令");
  return _pythonCmd;
}

/** 从 Python 脚本第一行 #! {...} 解析元数据 */
function readPythonMeta(filePath: string): PythonToolMeta | null {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^#!\s*(\{.*\})\s*$/);
    if (match) {
      try {
        return JSON.parse(match[1]) as PythonToolMeta;
      } catch {
        logger.warn(`[Registry] Python 脚本元数据解析失败: ${filePath}`);
        return null;
      }
    }
  }
  logger.warn(`[Registry] Python 脚本缺少元数据头: ${filePath}`);
  return null;
}

// ---------- 加载器 ----------

/**
 * 加载 .agent/tools/ 下的自定义工具。
 * - .ts / .js 文件：通过 import() 动态加载，导出 name/execute 对
 * - .py 文件：通过第一行 #! {...} 元数据注册，执行时 spawn python 子进程
 */
async function loadCustomTools(cwd: string): Promise<ToolDefinition[]> {
  const toolsDir = join(cwd, ".agent/tools");
  if (!existsSync(toolsDir)) return [];

  const tools: ToolDefinition[] = [];
  const files = readdirSync(toolsDir).filter((f) => {
    const ext = extname(f).toLowerCase();
    return ext === ".ts" || ext === ".js" || ext === ".py";
  });

  for (const file of files) {
    const filePath = join(toolsDir, file);
    const ext = extname(file).toLowerCase();

    try {
      if (ext === ".py") {
        // ---- Python 脚本工具 ----
        const meta = readPythonMeta(filePath);
        if (!meta) continue;

        const pythonCmd = detectPython();
        tools.push({
          name: meta.name,
          label: meta.name,
          description: meta.description,
          parameters: meta.parameters ?? { type: "object", properties: {} },
          execute: async (_id, params, _signal, _onUpdate, _ctx) => {
            return new Promise((resolve) => {
              const child = execFile(
                pythonCmd,
                [filePath],
                {
                  maxBuffer: 10 * 1024 * 1024,
                  timeout: 30_000,
                  windowsHide: true,
                },
                (error, stdout, stderr) => {
                  if (error) {
                    resolve({
                      content: [
                        {
                          type: "text" as const,
                          text: stderr
                            ? `工具执行失败: ${stderr}`
                            : `工具执行失败(${error.code || "unknown"}): ${error.message}`,
                        },
                      ],
                      details: {} as any,
                    });
                    return;
                  }
                  try {
                    resolve(JSON.parse(stdout));
                  } catch {
                    resolve({ content: [{ type: "text" as const, text: stdout }], details: {} as any });
                  }
                },
              );
              child.stdin!.end(JSON.stringify(params ?? {}));
            });
          },
        });
        logger.info(`[Registry] 加载 Python 工具: ${meta.name} (${file})`);
      } else {
        // ---- TS / JS 脚本工具 ----
        const module = await import(pathToFileURL(filePath).href);
        const tool = module.default ||
          Object.values(module).find((exp: any) => exp?.name && exp?.execute);

        if (tool && typeof tool === "object" && "name" in tool && "execute" in tool) {
          tools.push(tool as ToolDefinition);
          logger.info(`[Registry] 加载工具: ${(tool as ToolDefinition).name} (${file})`);
        }
      }
    } catch (error) {
      logger.warn(`[Registry] 加载工具失败: ${file} ${error instanceof Error ? error.message : error}`);
    }
  }

  return tools;
}

/**
 * 创建工具注册表（异步版本，加载 .agent/tools/ 下的用户自定义工具）
 */
export async function createToolRegistryAsync(cwd: string, tools: FeishuPiTool[] = []): Promise<ToolDefinition[]> {
  const customTools = await loadCustomTools(cwd);
  return [...customTools, ...(tools as ToolDefinition[])];
}