import { readFile, stat } from "node:fs/promises";
import { matchGlobs } from "../utils/path-glob.ts";
import { logger } from "../utils/logger.ts";

/** 白名单中的四类能力。 */
export interface GroupFields {
  bash?: string[];
  read?: string[];
  write?: string[];
  tools?: string[];
}

type RoleName = "admin" | "group";
type DenyKind = "bash" | "read" | "write" | "tools";

interface DenyRule {
  kind: DenyKind;
  pattern: string;
  raw: string;
}

/** 已编译的调用者权限。白名单只负责确定性放行，未命中统一交给 LLM 门禁。 */
export interface GroupPolicy {
  groups: RoleName[];
  isAdmin: boolean;
  isTeam: boolean;
  bashAllowed(command: string): boolean;
  readAllowed(path: string): boolean;
  writeAllowed(path: string): boolean;
  toolsAllowed(name: string): boolean;
  /** deny：按工具类型和参数通配匹配；命中阻止白名单直通，转管理员授权流程。 */
  denied(toolName: string, args: unknown): string | undefined;
  describe(): Required<Omit<GroupFields, "tools">> & { tools: string[] };
}

const ROLE_NAMES: RoleName[] = ["admin", "group"];

/** shell 拼接命令不能走确定性 Bash 白名单；会进入 LLM 门禁。 */
export const SHELL_META = /[;&|`$<>\()\r\n]/;

export class PermissionPolicy {
  private readonly filePath: string;
  private readonly adminId?: string;
  private readonly cwd: string;

  private groups: Record<RoleName, GroupFields> = { admin: {}, group: {} };
  private denyRules: DenyRule[] = [];
  private loadedMtimeMs = -1;
  private warned = false;

  constructor(filePath: string, options: { adminId?: string; cwd?: string } = {}) {
    this.filePath = filePath;
    this.adminId = options.adminId || undefined;
    this.cwd = options.cwd ?? process.cwd();
  }

  /** 只有管理员和团队两个角色；所有非管理员自动属于 group，不读取团队名单或用户资料。 */
  async groupsFor(userId: string, _userName?: string): Promise<RoleName[]> {
    return this.adminId && userId === this.adminId ? ["admin"] : ["group"];
  }

  async preload(): Promise<void> {
    await this.ensureLoaded();
  }

  async forGroups(requested: string[]): Promise<GroupPolicy> {
    await this.ensureLoaded();
    const groups = ROLE_NAMES.filter((name) => requested.includes(name));
    const isAdmin = groups.includes("admin");
    const isTeam = groups.includes("group");
    const merged = this.mergeFields(groups.map((name) => this.groups[name]));
    const bashAll = merged.bash.includes("*");
    const bashRules = merged.bash.filter((rule) => rule !== "*").map((rule) =>
      rule.endsWith(":*") ? { prefix: rule.slice(0, -2).trimEnd() } : { exact: rule },
    );

    return {
      groups,
      isAdmin,
      isTeam,
      bashAllowed: (command) => {
        if (bashAll) return true;
        if (SHELL_META.test(command)) return false;
        return bashRules.some((rule) => rule.prefix !== undefined
          ? command === rule.prefix || command.startsWith(`${rule.prefix} `) || command.startsWith(`${rule.prefix}\t`)
          : command === rule.exact);
      },
      readAllowed: (path) => matchGlobs(merged.read, path, this.cwd),
      writeAllowed: (path) => matchGlobs(merged.write, path, this.cwd),
      toolsAllowed: (name) => merged.tools.includes("*") || merged.tools.includes(name),
      denied: (toolName, args) => this.matchDeny(toolName, args),
      describe: () => ({ ...merged }),
    };
  }

  async describe(): Promise<{
    groups: Record<RoleName, GroupFields & { effective: Required<Omit<GroupFields, "tools">> & { tools: string[] } }>;
    deny: string[];
  }> {
    await this.ensureLoaded();
    const groups = {} as Record<RoleName, GroupFields & { effective: Required<Omit<GroupFields, "tools">> & { tools: string[] } }>;
    for (const name of ROLE_NAMES) groups[name] = { ...this.groups[name], effective: this.mergeFields([this.groups[name]]) };
    return { groups, deny: this.denyRules.map((rule) => rule.raw) };
  }

  private mergeFields(sources: GroupFields[]): Required<Omit<GroupFields, "tools">> & { tools: string[] } {
    const keys = ["bash", "read", "write", "tools"] as const;
    const merged: Record<(typeof keys)[number], string[]> = { bash: [], read: [], write: [], tools: [] };
    for (const key of keys) {
      const items = new Set<string>();
      for (const fields of sources) for (const item of fields[key] ?? []) items.add(item);
      merged[key] = [...items];
    }
    return merged;
  }

  private matchDeny(toolName: string, args: unknown): string | undefined {
    const command = extractCommand(args);
    const path = extractPath(args);
    return this.denyRules.find((rule) => {
      if (rule.kind === "bash") return toolName === "bash" && command !== undefined && matchGlobs([rule.pattern], command);
      if (rule.kind === "read") return toolName === "read" && path !== undefined && matchGlobs([rule.pattern], path, this.cwd);
      if (rule.kind === "write") return (toolName === "write" || toolName === "edit") && path !== undefined && matchGlobs([rule.pattern], path, this.cwd);
      return matchGlobs([rule.pattern], toolName);
    })?.raw;
  }

  private async ensureLoaded(): Promise<void> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.filePath)).mtimeMs;
    } catch {
      this.groups = { admin: {}, group: {} };
      this.denyRules = [];
      this.loadedMtimeMs = -1;
      return;
    }
    if (mtimeMs === this.loadedMtimeMs) return;

    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, unknown>;
      const allow = (typeof raw.allow === "object" && raw.allow !== null ? raw.allow : {}) as Record<string, unknown>;
      this.groups = { admin: sanitizeGroup(allow.admin), group: sanitizeGroup(allow.group) };
      this.denyRules = sanitizeDeny(raw.deny);
      this.loadedMtimeMs = mtimeMs;
      logger.info(`[Policy] 已加载权限策略: admin(${countRules(this.groups.admin)}) group(${countRules(this.groups.group)}) deny(${this.denyRules.length})`);
    } catch (error) {
      if (!this.warned) logger.warn(`[Policy] 策略文件解析失败，按空白名单处理: ${error instanceof Error ? error.message : String(error)}`);
      this.warned = true;
      this.groups = { admin: {}, group: {} };
      this.denyRules = [];
      this.loadedMtimeMs = -1;
    }
  }
}

function countRules(fields: GroupFields): number {
  return (fields.bash?.length ?? 0) + (fields.read?.length ?? 0) + (fields.write?.length ?? 0) + (fields.tools?.length ?? 0);
}

const ENTRY_RE = /^(?<type>[A-Za-z]+)\((?<pattern>.*)\)$/;

function sanitizeGroup(value: unknown): GroupFields {
  const out: GroupFields = {};
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (typeof item !== "string") continue;
    const match = item.match(ENTRY_RE);
    const kind = match?.groups?.type.toLowerCase() as DenyKind | undefined;
    const pattern = match?.groups?.pattern;
    if (!kind || !pattern || !["bash", "read", "write", "tools"].includes(kind)) continue;
    (out[kind] ??= []).push(pattern);
  }
  return out;
}

/** deny 和 allow 使用同一套 `Bash(...)` / `Read(...)` / `Write(...)` / `Tools(...)` 通配语法。 */
function sanitizeDeny(value: unknown): DenyRule[] {
  if (!Array.isArray(value)) return [];
  const rules: DenyRule[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const match = item.match(ENTRY_RE);
    const kind = match?.groups?.type.toLowerCase() as DenyKind | undefined;
    const pattern = match?.groups?.pattern;
    if (!kind || !pattern || !["bash", "read", "write", "tools"].includes(kind)) continue;
    rules.push({ kind, pattern, raw: item });
  }
  return rules;
}

function extractPath(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file_path"]) if (typeof record[key] === "string" && record[key]) return record[key] as string;
  return undefined;
}

function extractCommand(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}
