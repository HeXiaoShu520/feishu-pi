import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { join, extname } from "node:path";
import { loadToolModule } from "./module-loader.ts";
import { resourceEnabled, type ResourceSelection } from "../resources/config.ts";
import { logger } from "../utils/logger.ts";

export const DEFAULT_BUILTIN_TOOLS = ["read", "write", "edit", "bash"] as const;

interface PythonToolMeta {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  risk?: "high";
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

/** 自定义工具不得占用的内置工具名：同名会覆盖内置实现，绕过对应的 Guard 链（如 read 的可读范围判定） */
const RESERVED_TOOL_NAMES = new Set<string>([...DEFAULT_BUILTIN_TOOLS, "browser", "memory", "background_task", "mcp", "ask_user_question", "schedule_manager", "sticker_send"]);

/** 内置同名工具拒绝登记；返回 undefined 表示应跳过该工具 */
function checkReservedName(name: string, file: string): boolean {
  if (!RESERVED_TOOL_NAMES.has(name)) return true;
  logger.warn(`[Registry] 跳过 ${file}：自定义工具名「${name}」与内置工具冲突（会绕过对应权限链）`);
  return false;
}

// ---------- 加载器 ----------

/** 上一次加载的自定义工具签名：用于"仅在首次/工具集变化时打日志" */
let _lastToolSignature: string | null = null;

/**
 * 加载顶层 TS/JS/MJS、目录 index 入口及兼容的 Python 元数据工具。
 * TS/JS 模块的导出和 schema 在注册前校验；名称冲突会报错。 *
 * 调用方注意：Runtime 用 customToolsOnce 在进程内缓存本函数结果（见 feishu-pi-runtime.ts），
 * 因此实际只在启动时加载一次——**改 .agent/tools/ 必须重启进程**，没有热更新。
 * 下面的签名比对只在重复调用的场景下起作用，避免同一工具集重复刷日志。
 */
async function loadCustomTools(cwd: string): Promise<ToolDefinition[]> {
  const toolsDir = join(cwd, ".agent/tools");
  if (!existsSync(toolsDir)) return [];

  const tools: ToolDefinition[] = [];
  const entries: Array<{ name: string; file: string }> = [];
  const files: string[] = [];
  for (const entry of readdirSync(toolsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && [".ts", ".js", ".mjs", ".py"].includes(extname(entry.name).toLowerCase())) files.push(entry.name);
    else if (entry.isDirectory()) {
      const indexes = readdirSync(join(toolsDir, entry.name), { withFileTypes: true }).filter((child) => child.isFile() && /^index\.(ts|js|mjs)$/.test(child.name));
      if (indexes.length > 1) throw new Error(`${entry.name}: 只能保留一个 index 入口`);
      if (indexes[0]) files.push(join(entry.name, indexes[0].name));
    }
  }

  for (const file of files) {
    const filePath = join(toolsDir, file);
    const ext = extname(file).toLowerCase();

    try {
      if (ext === ".py") {
        // ---- Python 脚本工具 ----
        const meta = readPythonMeta(filePath);
        if (!meta) continue;
        if (!checkReservedName(meta.name, filePath)) continue;

        const pythonCmd = detectPython();
        tools.push({
          name: meta.name,
          label: meta.name,
          description: meta.description,
          parameters: meta.parameters ?? { type: "object", properties: {} },
          ...(meta.risk === "high" ? { risk: "high" as const } : {}),
          execute: async (_id, params, _signal, _onUpdate, _ctx) => {
            return new Promise((resolve) => {
              const child = execFile(
                pythonCmd,
                [filePath],
                {
                  maxBuffer: 10 * 1024 * 1024,
                  timeout: 30_000,
                  windowsHide: true,
                  cwd,
                  signal: _signal,
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
                      details: {},
                    });
                    return;
                  }
                  try {
                    resolve(JSON.parse(stdout));
                  } catch {
                    resolve({ content: [{ type: "text" as const, text: stdout }], details: {} });
                  }
                },
              );
              // Python 脚本未读 stdin 就退出时 end() 会触发 EPIPE，
              // 不挂 error 监听会以 uncaught exception 冒泡并崩掉整个进程
              child.stdin!.on("error", () => {});
              child.stdin!.end(JSON.stringify(params ?? {}));
            });
          },
        });
        entries.push({ name: meta.name, file });
      } else {
        // TS/JS modules use explicit exports and validate their schemas before registration.
        for (const tool of await loadToolModule(filePath)) {
          if (!checkReservedName(tool.name, filePath)) throw new Error(`工具名 ${tool.name} 与内置能力冲突`);
          tools.push(tool);
          entries.push({ name: tool.name, file });
        }
      }
    } catch (error) {
      throw new Error(`[Registry] 加载工具失败: ${file} ${error instanceof Error ? error.message : error}`);
    }
  }

  const signature = entries.map((e) => `${e.name}(${e.file})`).join(", ");
  if (signature !== _lastToolSignature) {
    const isFirst = _lastToolSignature === null;
    _lastToolSignature = signature;
    // 首次加载的逐行清单由 Runtime.printAvailableResources 统一打印（Skills 之后）；
    // 这里只在工具集发生变化（热更新）时打一条简短通知
    if (!isFirst) logger.info(`[Registry] 工具集变化，已重新加载 ${entries.length} 个自定义工具`);
  }

  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`工具名 ${tool.name} 重复`);
    names.add(tool.name);
  }
  return tools;
}

/**
 * 创建工具注册表（异步版本，加载 .agent/tools/ 下的用户自定义工具）
 */
export async function createToolRegistryAsync(cwd: string, selection: ResourceSelection = { enabled: true, include: ["*"], exclude: [] }): Promise<ToolDefinition[]> {
  if (!selection.enabled) return [];
  return (await loadCustomTools(cwd)).filter((tool) => resourceEnabled(selection, tool.name));
}
