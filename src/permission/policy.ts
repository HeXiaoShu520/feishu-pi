import { readFile, stat } from "node:fs/promises";
import { matchGlobs } from "../utils/path-glob.ts";
import { logger } from "../utils/logger.ts";

/**
 * 统一权限策略：一个文件（.agent/permissions.json）只有两个输入——
 *
 *   {
 *     "deny":  ["禁止读写的路径 glob，第 0 层，对所有人含管理员生效"],
 *     "allow": {
 *       "common":  ["Read(.agent/skills/**)"],
 *       "admin":   ["Bash(git status:*)", "Read(**)", "Write(.agent/**)", "Tools(*)"],
 *       "group_1": ["Bash(npm run test:*)", "Read(docs/**)"]
 *     }
 *   }
 *
 * allow 里每组为规则数组，前导词：
 *   - Bash(命令)   — 命令精确匹配、`cmd:*` 前缀匹配或 "*"（该组可执行的 bash 命令）
 *   - Read(路径glob) — 该组可读的路径范围
 *   - Write(路径glob) — 该组可写的路径范围
 *   - Tools(工具名)  — 该组可调用的自定义工具，精确名称或 "*"（全部）
 *
 * allow 里的保留组名：
 *   - common——所有人默认拥有的基础权限（每个用户自动叠加，无需归属）；
 *   - admin——管理员组，FEISHU_ADMIN 自动属于；未配置的字段取全量缺省。
 *   其余组名任取（团队组如 group、group_1、group_2……）。
 *
 * 组成员在 .env 中通过 FEISHU_GROUP_<组名>=成员1,成员2,... 配置；
 * 纯数字后缀简写为团队组：FEISHU_GROUP_1 → group_1、FEISHU_GROUP_2 → group_2。
 *
 * 生效范围 = common ∪ 所属各组并集。组文件 mtime 热重载，新会话生效。
 * 名单之外的调用一律交授权卡（非允许即 ask）；read 范围外交直接拦截（能力问题不问人）。
 * 文件缺失或解析失败时按保守默认处理（仅技能目录可读、无工具、无命令）。
 *
 * deny（第 0 层）：与内置默认模式（.env 等环境配置与密钥/凭据文件）合并，
 * 先于一切 allow 规则判定，对所有人（含管理员）生效——
 * 敏感配置不允许经智能体读或写（read 路径 / write·edit 路径 / bash 命令引用均拦截）。
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
  /** deny 规则（第 0 层）：路径引用命中禁止清单时返回命中的模式，未命中返回 undefined */
  deniedPath(pathRef: string): string | undefined;
  /** 生效范围（/perm 展示用） */
  describe(): Required<Omit<GroupFields, "tools">> & { tools: string[] };
}

/** 不在任何组时的保守缺省：仅技能目录可读（零配置行为） */
const UNGROUPED_READ = [".agent/skills/**"];

/**
 * deny 例外（白名单）：命中的路径即便匹配 deny 模式也放行。
 * .env.example / *.env.example 是无密钥的配置模板，需要可读；
 * 其余 .env 变体仍然拦截。
 */
const DENY_EXCEPTIONS: readonly string[] = ["**/.env.example", "**/*.env.example"];

/** bash 命令里的 shell 链接符：命中即不参与前缀/精确匹配（防 `npm run test; rm -rf /` 逃逸）。
 *  换行符必须包含：多行命令的第二行不被前缀规则覆盖（`git status\nrm -rf /` 会整段放行）。 */
const SHELL_META = /[;&|`]|\$\(|[\r\n]/;

export class PermissionPolicy {
  private readonly filePath: string;
  private readonly adminId?: string;
  private readonly usersFile?: string;
  private readonly cwd: string;

  private groups: Record<string, GroupFields> = {};
  /** common 默认层：所有人自动叠加的基础权限 */
  private common: GroupFields = {};
  /** deny 模式（permissions.json 顶层 "deny"，第 0 层的唯一来源） */
  private denyExtras: string[] = [];
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

  /** 当前生效的 deny 模式全集（完全来自 permissions.json 顶层 "deny"，无内置默认）。 */
  private get denyPatterns(): string[] {
    return this.denyExtras;
  }

  /**
   * 解析调用者所属的组集合：FEISHU_ADMIN → admin；
   * 其余按环境变量 FEISHU_GROUP_<NAME> 配置的成员匹配
   * （全套标识：openId + 中文名 + 英文名 + 组织架构部门名，姓名/部门从用户缓存补充——
   * 成员项写部门名（如 系统工程部）时，用户缓存中的部门路径包含该名称即视为命中）。
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
      if (members.some((member) => identifiers.has(member))) {
        groups.add(name);
        continue;
      }
      // 部门名匹配：成员项不是 open_id，且用户缓存的任一部门路径包含该名称（大小写不敏感）
      const departmentPaths = profile?.department_name ?? [];
      if (departmentPaths.some((path) =>
        members.some((member) =>
          !member.startsWith("ou_") && member.length >= 2 && path.toLowerCase().includes(member.toLowerCase()),
        ),
      )) {
        groups.add(name);
      }
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
    const denyGlobs = this.denyPatterns;

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
      deniedPath: (pathRef) => {
        const hit = denyGlobs.find((pattern) => matchGlobs([pattern], pathRef, cwd));
        if (hit === undefined) return undefined;
        // 例外优先：.env.example 这类无密钥模板不拦
        if (matchGlobs([...DENY_EXCEPTIONS], pathRef, cwd)) return undefined;
        return hit;
      },
      describe: () => ({ ...merged }),
    };
  }

  /** 全部组概览（/perm 展示用）：每组生效范围 + deny 模式全集。 */
  async describe(): Promise<{
    groups: Record<string, GroupFields & { effective: Required<Omit<GroupFields, "tools">> & { tools: string[] } }>;
    deny: string[];
  }> {
    await this.ensureLoaded();
    const names = new Set<string>(["admin", "common", ...Object.keys(this.groups)]);
    const out: Record<string, GroupFields & { effective: Required<Omit<GroupFields, "tools">> & { tools: string[] } }> = {};
    for (const name of names) {
      const own = name === "common" ? this.common : this.groups[name] ?? {};
      const sources = name === "common" ? [this.common] : [this.common, this.fieldsFor(name)];
      out[name] = { ...own, effective: this.mergeFields(sources) };
    }
    return { groups: out, deny: this.denyPatterns };
  }

  /** 组文件加载；mtime 变化时重载。缺失/非法时按空组处理（fail-safe），deny 仍有内置默认兜底。 */
  private async ensureLoaded(): Promise<void> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.filePath)).mtimeMs;
    } catch {
      this.groups = {};
      this.common = {};
      this.denyExtras = [];
      this.loadedMtimeMs = -1;
      return;
    }
    if (mtimeMs === this.loadedMtimeMs) return;

    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, unknown>;
      this.groups = {};
      this.common = {};
      this.denyExtras = sanitizeDeny(raw.deny);

      // allow：各身份组的规则数组（保留组名 common/admin + 任意命名用户组）
      const allow = (typeof raw.allow === "object" && raw.allow !== null ? raw.allow : {}) as Record<string, unknown>;
      for (const [name, fields] of Object.entries(allow)) {
        if (name.startsWith("_")) continue;  // _ 开头视为注释
        if (name === "common") {
          this.common = sanitizeGroup(fields);  // 保留组名：所有人默认叠加
          continue;
        }
        this.groups[name] = sanitizeGroup(fields);
      }
      this.loadedMtimeMs = mtimeMs;
      logger.info(`[Policy] 已加载权限策略（${this.filePath}），deny 保护 ${this.denyPatterns.length} 条模式`);
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        logger.warn(`[Policy] 策略文件解析失败，按保守默认处理: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.groups = {};
      this.common = {};
      this.denyExtras = [];
      this.loadedMtimeMs = -1;
    }
  }

  /** 用户缓存（openId → 中文名/英文名/部门路径），mtime 缓存，供成员名与部门名匹配。 */
  private profileCache = new Map<string, { name?: string; en_name?: string; department_name?: string[] }>();
  private profileMtimeMs = -1;

  private async loadProfile(openId: string): Promise<{ name?: string; en_name?: string; department_name?: string[] } | undefined> {
    if (!this.usersFile) return undefined;
    try {
      const mtimeMs = (await stat(this.usersFile)).mtimeMs;
      if (mtimeMs !== this.profileMtimeMs) {
        const parsed = JSON.parse(await readFile(this.usersFile, "utf8")) as Record<string, { name?: string; en_name?: string; department_name?: string[] }>;
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

/** deny 清单解析：字符串数组，其余类型忽略。 */
function sanitizeDeny(fields: unknown): string[] {
  return Array.isArray(fields) ? fields.filter((item): item is string => typeof item === "string") : [];
}

/** 组规则解析：条目必须是 "前导词(模式)" 字符串数组，其余形态按空组处理。 */
function sanitizeGroup(fields: unknown): GroupFields {
  const out: GroupFields = {};
  if (Array.isArray(fields)) parseRuleEntries(fields, out);
  return out;
}

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}