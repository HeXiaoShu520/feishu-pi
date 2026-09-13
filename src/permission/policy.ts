import { readFile, stat } from "node:fs/promises";
import { matchGlobs } from "../utils/path-glob.ts";
import { logger } from "../utils/logger.ts";

/**
 * 统一权限策略：一个文件（.agent/permissions.json）定义若干身份组——
 * admin（管理员组）与任意多个用户组（group1、vip……组名任取）——各自的可调用范围。
 *
 *   {
 *     "admin":  ["Bash(git status:*)", "Read(**)", "Write(.agent/**)", "Tools(*)"],
 *     "group1": ["Bash(npm run test:*)", "Read(docs/**)", "Tools(query_skill_usage)"]
 *   }
 *
 * 规则前导词：
 *   - Bash(命令)   — 命令精确匹配、`cmd:*` 前缀匹配或 "*"（该组可执行的 bash 命令）
 *   - Read(路径glob) — 该组可读的路径范围
 *   - Write(路径glob) — 该组可写的路径范围
 *   - Tools(工具名)  — 该组可调用的自定义工具，精确名称或 "*"（全部）
 *
 * 组成员在 .env 中通过 FEISHU_GROUP_<组名>=成员1,成员2,... 配置。
 * 保留组名：
 *   - common——所有人默认拥有的基础权限（每个用户自动叠加，无需归属）；
 *   - admin——管理员组，FEISHU_ADMIN 或 FEISHU_GROUP_ADMIN 自动属于；未配置的字段取全量缺省。
 *
 * 生效范围 = common ∪ 所属各组并集。组文件 mtime 热重载，新会话生效。
 * 名单之外的调用一律交授权卡（非允许即 ask）；read 范围外交直接拦截（能力问题不问人）。
 * 文件缺失或解析失败时按保守默认处理（仅技能目录可读、无工具、无命令）。
 */

export interface GroupFields {
  bash?: string[];
  read?: string[];
  write?: string[];
  tools?: string[];
}

/** 编译后的组策略：各类调用的判定函数 */
export interface GroupPolicy {
  /** 命中的组名（含 admin） */
  groups: string[];
  isAdmin: boolean;
  bashAllowed(command: string): boolean;
  readAllowed(path: string): boolean;
  writeAllowed(path: string): boolean;
  /** 自定义工具（.agent/tools/ 中的 Python/TS 脚本）是否对该组可用 */
  toolsAllowed(name: string): boolean;
  /** 生效范围（/perm 展示用） */
  describe(): Required<Omit<GroupFields, "tools">> & { tools: string[] };
}

/** 不在任何组时的保守缺省：仅技能目录可读（零配置行为） */
const UNGROUPED_READ = [".agent/skills/**"];

/** bash 命令里的 shell 链接符：命中即不参与前缀/精确匹配（防 `npm run test; rm -rf /` 逃逸） */
const SHELL_META = /[;&|`]|\$\(/;

export class PermissionPolicy {
  private readonly filePath: string;
  private readonly adminId?: string;
  private readonly usersFile?: string;
  private readonly cwd: string;

  private groups: Record<string, GroupFields> = {};
  /** common 默认层：所有人自动叠加的基础权限 */
  private common: GroupFields = {};
  private groupMembership: Record<string, string[]>;
  private loadedMtimeMs = -1;
  private warned = false;

  constructor(filePath: string, options: { adminId?: string; groupMembership?: Record<string, string[]>; usersFile?: string; cwd?: string } = {}) {
    this.filePath = filePath;
    this.adminId = options.adminId || undefined;
    this.groupMembership = options.groupMembership ?? {};
    this.usersFile = options.usersFile;
    this.cwd = options.cwd ?? process.cwd();
  }

  /**
   * 解析调用者所属的组集合：FEISHU_ADMIN → admin；
   * 其余按环境变量 FEISHU_GROUP_<NAME> 配置的成员匹配
   * （全套标识：openId + 中文名 + 英文名，英文名从用户缓存补充）。
   * 不在任何组 → 空集合（保守：仅技能目录可读）。
   */
  async groupsFor(userId: string, userName?: string): Promise<string[]> {
    await this.ensureLoaded();

    const groups = new Set<string>();
    if (this.adminId && userId === this.adminId) groups.add("admin");

    const identifiers = new Set<string>([userId]);
    if (userName) identifiers.add(userName);
    const profile = await this.loadProfile(userId);
    if (profile?.name) identifiers.add(profile.name);
    if (profile?.en_name) identifiers.add(profile.en_name);

    for (const [name, members] of Object.entries(this.groupMembership)) {
      if (members.some((member) => identifiers.has(member))) groups.add(name);
    }
    return [...groups];
  }

  /** 单组字段：admin 组叠加全量缺省，其余组叠加保守缺省 */
  private fieldsFor(name: string): Required<Omit<GroupFields, "tools">> & { tools: string[] } {
    if (name === "admin") return { ...adminDefaults(), ...stripUndefined(this.groups.admin ?? {}) };
    return { ...ungroupedDefaults(), ...stripUndefined(this.groups[name] ?? {}) };
  }

  /** 逐字段并集；read 空 → 技能目录（保守缺省），bash/write/tools 空保持空（保守） */
  private mergeFields(sources: GroupFields[]): Required<Omit<GroupFields, "tools">> & { tools: string[] } {
    const keys = ["bash", "read", "write", "tools"] as const;
    const merged: Record<(typeof keys)[number], string[]> = {
      bash: [], read: [], write: [], tools: [],
    };
    for (const key of keys) {
      const set = new Set<string>();
      for (const fields of sources) for (const item of fields[key] ?? []) set.add(item);
      merged[key] = [...set];
    }
    if (merged.read.length === 0) merged.read = [...UNGROUPED_READ];
    return merged;
  }

  /** 启动预加载：上电即读取策略文件（避免首条消息才触发加载日志）。 */
  async preload(): Promise<void> {
    await this.ensureLoaded();
  }

  /** 合并编译多组策略（common ∪ 各组并集；无 admin 时保守缺省）。 */
  async forGroups(groups: string[]): Promise<GroupPolicy> {
    await this.ensureLoaded();
    const cwd = this.cwd;
    const isAdmin = groups.includes("admin");

    // 合并顺序：common（人人默认）→ 所属各组（admin 组另有全量缺省）
    const sources: GroupFields[] = [this.common];
    for (const g of groups) sources.push(this.fieldsFor(g));
    const merged = this.mergeFields(sources);

    const bashAll = merged.bash.includes("*");
    const bashRules = merged.bash.filter((r) => r !== "*").map((r) =>
      r.endsWith(":*") ? { prefix: r.slice(0, -2).trimEnd() } : { exact: r },
    );

    const toolsAll = merged.tools.includes("*");

    return {
      groups,
      isAdmin,
      bashAllowed: (command) => {
        if (bashAll) return true;
        if (SHELL_META.test(command)) return false; // 拼接逃逸不参与匹配，交授权卡
        return bashRules.some((rule) =>
          rule.prefix !== undefined ? command.startsWith(rule.prefix) : command === rule.exact,
        );
      },
      readAllowed: (path) => matchGlobs(merged.read, path, cwd),
      writeAllowed: (path) => matchGlobs(merged.write, path, cwd),
      toolsAllowed: (name) => toolsAll || merged.tools.includes(name),
      describe: () => ({ ...merged }),
    };
  }

  /** 全部组概览（/perm 展示用）：每组生效范围。 */
  async describe(): Promise<{
    groups: Record<string, GroupFields & { effective: Required<Omit<GroupFields, "tools">> & { tools: string[] } }>;
  }> {
    await this.ensureLoaded();
    const names = new Set<string>(["admin", "common", ...Object.keys(this.groups)]);
    const out: Record<string, GroupFields & { effective: Required<Omit<GroupFields, "tools">> & { tools: string[] } }> = {};
    for (const name of names) {
      const own = name === "common" ? this.common : this.groups[name] ?? {};
      const sources = name === "common" ? [this.common] : [this.common, this.fieldsFor(name)];
      out[name] = { ...own, effective: this.mergeFields(sources) };
    }
    return { groups: out };
  }

  /** 组文件加载；mtime 变化时重载。缺失/非法时按空组处理（fail-safe）。 */
  private async ensureLoaded(): Promise<void> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.filePath)).mtimeMs;
    } catch {
      this.groups = {};
      this.common = {};
      this.loadedMtimeMs = -1;
      return;
    }
    if (mtimeMs === this.loadedMtimeMs) return;

    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, unknown>;
      this.groups = {};
      this.common = {};
      for (const [name, fields] of Object.entries(raw)) {
        if (name.startsWith("_")) continue;  // _ 开头视为注释
        if (name === "common") {
          this.common = sanitize(fields);  // 保留组名：所有人默认叠加
          continue;
        }
        this.groups[name] = sanitize(fields);
      }
      this.loadedMtimeMs = mtimeMs;
      logger.info(`[Policy] 已加载权限策略（${this.filePath}）`);
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        logger.warn(`[Policy] 策略文件解析失败，按保守默认处理: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.groups = {};
      this.common = {};
      this.loadedMtimeMs = -1;
    }
  }

  /** 用户缓存（openId → 中文名/英文名），mtime 缓存，供成员名匹配。 */
  private profileCache = new Map<string, { name?: string; en_name?: string }>();
  private profileMtimeMs = -1;

  private async loadProfile(openId: string): Promise<{ name?: string; en_name?: string } | undefined> {
    if (!this.usersFile) return undefined;
    try {
      const mtimeMs = (await stat(this.usersFile)).mtimeMs;
      if (mtimeMs !== this.profileMtimeMs) {
        const parsed = JSON.parse(await readFile(this.usersFile, "utf8")) as Record<string, { name?: string; en_name?: string }>;
        this.profileCache = new Map(Object.entries(parsed));
        this.profileMtimeMs = mtimeMs;
      }
      return this.profileCache.get(openId);
    } catch {
      return undefined;
    }
  }
}

function adminDefaults(): Required<Omit<GroupFields, "tools">> & { tools: string[] } {
  return { bash: ["*"], read: ["**"], write: ["**"], tools: ["*"] };
}

function ungroupedDefaults(): Required<Omit<GroupFields, "tools">> & { tools: string[] } {
  return { bash: [], read: [".agent/skills/**"], write: [], tools: [] };
}

/** 规则条目正则：Bash(...)、Read(...)、Write(...)、Tools(...) */
const PREFIX_ENTRY_RE = /^(?<type>[A-Za-z]+)\((?<pattern>.*)\)$/;

/** 解析扁平规则数组：按前导词把条目分流到 bash/read/write/tools 字段，非法条目跳过。 */
function parseRuleEntries(entries: unknown[], out: GroupFields): void {
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const match = entry.match(PREFIX_ENTRY_RE);
    if (!match) continue;
    const type = match.groups!.type.toLowerCase();
    const pattern = match.groups!.pattern;
    if (!["bash", "read", "write", "tools"].includes(type)) continue;
    (out[type as keyof GroupFields] ??= []).push(pattern);
  }
}

function sanitize(fields: unknown): GroupFields {
  const out: GroupFields = {};

  // 新格式：组的值直接是数组
  if (Array.isArray(fields)) {
    parseRuleEntries(fields, out);
    return out;
  }

  // 向下兼容旧格式：{ bash: [...], read: [...], ... } 或 { allow: [...] }
  if (typeof fields !== "object" || fields === null) return {};
  const obj = fields as Record<string, unknown>;

  // 兼容 { allow: [...] } 过渡格式
  if (Array.isArray(obj.allow)) {
    parseRuleEntries(obj.allow, out);
    return out;
  }

  for (const key of ["bash", "read", "write", "tools"] as const) {
    const value = obj[key];
    if (Array.isArray(value)) out[key] = value.filter((item): item is string => typeof item === "string");
  }
  return out;
}

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}