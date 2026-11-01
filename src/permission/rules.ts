import { matchGlobs } from "../utils/path-glob.ts";

export interface PermissionFields { bash?: string[]; read?: string[]; write?: string[]; tools?: string[] }
export type RuleKind = keyof PermissionFields;
export interface PermissionRule {
  raw: string; kind: RuleKind; pattern: string;
  matches(toolName: string, args: unknown, cwd: string): boolean;
}

/** Action selectors share the Tools syntax: Tools(browser:snapshot). */
export function toolSelector(name: string, args: unknown): string {
  const action = (args as { action?: unknown } | null)?.action;
  return typeof action === "string" ? `${name}:${action}` : name;
}

export function compileRules(value: unknown): PermissionRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("deny / ask / allow 必须是数组");
  return value.map((raw): PermissionRule => {
    if (typeof raw !== "string") throw new Error("权限条目必须是字符串");
    const parsed = /^(Bash|Read|Write|Tools)\((.+)\)$/i.exec(raw);
    if (!parsed) throw new Error(`无效权限条目: ${raw}`);
    const kind = parsed[1].toLowerCase() as RuleKind;
    const pattern = parsed[2];
    return { raw, kind, pattern, matches: (name, args, cwd) => {
      const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const path = record.path ?? record.file_path;
      if (kind === "read") return name === "read" && typeof path === "string" && matchGlobs([pattern], path, cwd);
      if (kind === "write") return (name === "write" || name === "edit") && typeof path === "string" && matchGlobs([pattern], path, cwd);
      if (kind === "tools") return matchGlobs([pattern], name) || matchGlobs([pattern], toolSelector(name, args));
      if (name !== "bash" || typeof record.command !== "string") return false;
      if (pattern.endsWith(":*")) {
        const prefix = pattern.slice(0, -2).trimEnd();
        return record.command === prefix || record.command.startsWith(`${prefix} `) || record.command.startsWith(`${prefix}\t`);
      }
      return commandGlob(pattern, record.command);
    } };
  });
}

/** Shell text is not a filesystem path: * must also match slashes and newlines. */
function commandGlob(pattern: string, command: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "is").test(command.replace(/\\/g, "/"));
}
