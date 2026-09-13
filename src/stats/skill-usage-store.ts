/**
 * 技能使用统计：独立的追加式事件流，与 Pi session 无关。
 *
 * 为什么不基于 session 统计：session 文件是 Pi 内部格式（升级易碎）、7 天即被
 * DataCleaner 清理、且话题群的 session 由多人共享，无法按人归因。统计的核心
 * 维度是「人 × 技能 × 时间」，因此在工具执行前的钩子处（携带用户上下文）直接
 * 记录事件，长期留存于 data/stats/skill-usage.jsonl（JSONL，一行一条）。
 */
import { mkdir, readFile, stat, appendFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { logger } from "../utils/logger.ts";

/** 一条技能使用事件 */
export interface SkillUsageEvent {
  /** 事件时间（epoch 毫秒） */
  ts: number;
  /** 触发用户 Open ID（展示名在查询端按 英文名 > 中文名 > Open ID 解析） */
  user: string;
  /** 技能名（技能文件名去 .md） */
  skill: string;
  /** 发生会话（飞书 chatId），可选 */
  chatId?: string;
}

/** 用户缓存文件中单条记录的字段（与 LarkCli 的缓存结构对应） */
interface UserCacheRecord {
  openId: string;
  name?: string;
  en_name?: string;
}

/** 允许的技能目录前缀（相对 cwd，统一正斜杠后前缀匹配），与 restricted-read 保持一致 */
export const SKILL_DIR_PREFIXES = [".agent/skills/"];

/**
 * 判断一次工具调用是否为「读取技能文件」，是则返回技能名，否则返回 null。
 * 兼容两类 read 工具：内置 read 的参数是 path，受限 read 的参数是 file_path。
 */
export function matchSkillRead(toolName: string, args: unknown, cwd: string, agentDir: string): string | null {
  if (toolName !== "read") return null;
  const { path: p1, file_path: p2 } = (args ?? {}) as { path?: unknown; file_path?: unknown };
  const raw = typeof p1 === "string" ? p1 : typeof p2 === "string" ? p2 : undefined;
  if (!raw) return null;

  try {
    // 统一为相对 cwd 的正斜杠路径，Windows 下同样可做前缀匹配
    const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
    const rel = relative(cwd, abs).replace(/\\/g, "/");
    const relToAgent = relative(agentDir, abs).replace(/\\/g, "/");

    const inProjectSkills = SKILL_DIR_PREFIXES.some((prefix) => rel.startsWith(prefix));
    const inAgentSkills = agentDir !== cwd && relToAgent.startsWith("skills/") && !relToAgent.includes("..");
    if (!inProjectSkills && !inAgentSkills) return null;
    if (!rel.endsWith(".md")) return null;

    const base = rel.split("/").pop() ?? "";
    return base.replace(/\.md$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * 技能使用事件流存储：JSONL 追加写 + 内存读缓存。
 * 事件只增不删（长期留存，不参与 DataCleaner 清理）。
 */
export class SkillUsageStore {
  private readonly filePath: string;
  /** 用户缓存文件（data/users/{appId}_users.json），用于展示名解析；可选 */
  private readonly usersFile?: string;

  private events: SkillUsageEvent[] = [];
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  private usersCache: Map<string, UserCacheRecord> = new Map();
  private usersLoadedMtimeMs = -1;

  constructor(filePath: string, usersFile?: string) {
    this.filePath = filePath;
    this.usersFile = usersFile;
  }

  /** 记录一条事件：追加落盘（串行写队列）并同步进内存缓存。失败只告警，不影响工具执行。 */
  async record(event: SkillUsageEvent): Promise<void> {
    this.events.push(event);
    this.loaded = true;
    const write = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, JSON.stringify(event) + "\n", "utf8");
    });
    this.writeQueue = write.catch((error) => {
      logger.warn(`[SkillUsage] 事件写入失败: ${error instanceof Error ? error.message : String(error)}`);
    });
    await write;
  }

  /** 读取全部事件（懒加载文件后基于内存缓存返回快照）。 */
  async list(): Promise<SkillUsageEvent[]> {
    await this.ensureLoaded();
    return [...this.events];
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const content = await readFile(this.filePath, "utf8");
      this.events = content
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as SkillUsageEvent)
        .filter((e) => e && typeof e.ts === "number" && typeof e.user === "string" && typeof e.skill === "string");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(`[SkillUsage] 事件文件读取失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.events = [];
    }
    this.loaded = true;
  }

  /**
   * 解析用户展示名：英文名 > 中文名 > Open ID。
   * 数据来自 LarkCli 维护的用户缓存文件；文件被外部更新时按 mtime 重新加载。
   */
  async resolveDisplayName(openId: string): Promise<string> {
    await this.ensureUsers();
    const record = this.usersCache.get(openId);
    return record?.en_name || record?.name || openId;
  }

  /** 全量用户展示名映射（供统计页面批量解析，避免逐条查询）。 */
  async displayNameMap(): Promise<Record<string, string>> {
    await this.ensureUsers();
    const result: Record<string, string> = {};
    for (const [openId, record] of this.usersCache) {
      result[openId] = record.en_name || record.name || openId;
    }
    return result;
  }

  private async ensureUsers(): Promise<void> {
    if (!this.usersFile) return;
    try {
      const mtime = (await stat(this.usersFile)).mtimeMs;
      if (mtime === this.usersLoadedMtimeMs) return;
      const parsed = JSON.parse(await readFile(this.usersFile, "utf8")) as Record<string, UserCacheRecord>;
      this.usersCache = new Map(Object.entries(parsed));
      this.usersLoadedMtimeMs = mtime;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(`[SkillUsage] 用户缓存读取失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
