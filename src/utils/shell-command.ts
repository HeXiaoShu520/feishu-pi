import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface ShellStep {
  command: string;
  /** 与前一段的连接方式。 */
  before: "start" | ";" | "&&";
}

/** 只在引号外按 `;` / `&&` 分段；单独的 `&` 不属于可拆分命令。 */
export function parseShellSteps(command: string): ShellStep[] | undefined {
  const steps: ShellStep[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let start = 0;
  let before: ShellStep["before"] = "start";
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char !== ";" && char !== "&") continue;
    if (char === "&" && command[i + 1] !== "&") return undefined;
    const part = command.slice(start, i).trim();
    if (!part) return undefined;
    steps.push({ command: part, before });
    before = char === ";" ? ";" : "&&";
    if (before === "&&") i++;
    start = i + 1;
  }
  if (quote || escaped) return undefined;
  const last = command.slice(start).trim();
  if (!last) return undefined;
  steps.push({ command: last, before });
  return steps;
}

/** CLI 的全局身份选项可放在业务域前；白名单按业务域配置时忽略它的位置。 */
export function cliPolicyCommand(command: string): string {
  const trimmed = command.trimStart();
  const normalized = trimmed.replace(/^lark[-_]?cli(?:\.exe)?(?=\s|$)/i, "lark-cli");
  const match = /^lark-cli\s+--as(?:=|\s+)(?:user|bot)\s+([\s\S]+)$/i.exec(normalized);
  return match ? `lark-cli ${match[1]}` : normalized;
}

/** 只接受工程内的单一字面路径，供白名单判定使用。 */
export function resolveSafeCd(command: string, cwd: string, workspaceRoot: string): string | undefined {
  const match = /^cd\s+(.+)$/i.exec(command.trim());
  if (!match) return undefined;
  let path = match[1].trim();
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) {
    path = path.slice(1, -1);
  } else if (/\s|["']/.test(path)) {
    return undefined;
  }
  if (!path || path.startsWith("-") || /[;&|<>`$()\r\n]/.test(path)) return undefined;
  let target: string;
  let root: string;
  try {
    target = realpathSync(resolve(cwd, path));
    root = realpathSync(resolve(workspaceRoot));
    if (!statSync(target).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return target;
}
