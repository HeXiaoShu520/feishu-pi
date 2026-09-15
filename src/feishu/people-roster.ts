/**
 * 预制人员名单（people roster）：把消息里**按名字**提到的人识别成提示词。
 *
 * 背景：用户经常写"让张三看一下"而不是 @ 某人——模型不知道张三是谁、拿不到
 * open_id，自然 @ 不到人。而资料查询链路（lark-cli.ts）本来就会把见过的每个人
 * （openId → 中文名/英文名/部门）落在本名单文件（data/users/{appId}_users.json，
 * 与权限策略、管理员识别共用同一份）。
 *
 * 做法：每条消息入口用名单扫一遍消息文本，命中的人在本条 prompt 末尾补一段
 * 「人员提示」（open_id + 姓名/部门），模型据此就能正确识别并 @ 到人。
 * 不是全量扫通讯录——名单只随资料查询自然增长，零额外 API。
 */
import { readFile, stat } from "node:fs/promises";
import { logger } from "../utils/logger.ts";

/** 名单文件条目（与 LarkCli 资料缓存结构对齐） */
interface CachedProfile {
  name?: string;
  en_name?: string;
  department_name?: string[];
}

export interface RosterHit {
  openId: string;
  name: string;
  enName: string;
  departments: string[];
}

export interface RosterMatchOptions {
  /** 发送者本人：身份已在消息上下文里，不重复提示 */
  senderOpenId?: string;
  /** 最多提示人数，默认 8（防止长名单刷屏） */
  limit?: number;
}

/** 名字参与匹配的最小长度（单字中文名如"王"会满屏误命中，跳过） */
const MIN_NAME_CHARS = 2;
const DEFAULT_LIMIT = 8;
/** 每条消息最多参与匹配的字符数（超长消息只扫前 1000 字，开销恒定可控） */
const SCAN_MAX_CHARS = 1000;

/** at 标签整体剔除：被 @ 的人身份已在标签里，其展示文本（名字）不应再按名字命中 */
const AT_TAG_RE = /<at[^>]*>[\s\S]*?<\/at>|<at[^>]*\/?>/gi;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从归一化消息的 mentions 里提取"应入库"的被提及者 openId 列表（纯函数，供单测）：
 * 剔除无 openId 的项（@所有人）、机器人、发送者本人；按出现顺序去重。
 * 机器人双保险：SDK 的 isBot 标记 + 与 botOpenId 直接比对（任一命中即剔除）。
 */
export function mentionedUserIds(
  mentions: Array<{ openId?: string; isBot?: boolean }>,
  opts: { senderOpenId?: string; botOpenId?: string } = {},
): string[] {
  const result: string[] = [];
  for (const m of mentions) {
    if (!m.openId || m.isBot) continue;
    if (opts.botOpenId && m.openId === opts.botOpenId) continue;
    if (opts.senderOpenId && m.openId === opts.senderOpenId) continue;
    if (!result.includes(m.openId)) result.push(m.openId);
  }
  return result;
}

export class PeopleRoster {
  private readonly usersFile: string;
  private entries: Array<{ openId: string; name: string; enName: string; departments: string[] }> = [];
  private loadedMtimeMs = -1;

  constructor(usersFile: string) {
    this.usersFile = usersFile;
  }

  /**
   * 构造「人员提示」段：命中时返回多行文本（拼在本条 prompt 末尾），无命中返回 undefined。
   */
  async buildHint(text: string, senderOpenId?: string): Promise<string | undefined> {
    const hits = await this.match(text, { senderOpenId });
    if (hits.length === 0) return undefined;
    logger.info(`[Roster] 人员提示命中 ${hits.length} 人: ${hits.map((h) => h.name || h.enName).join("、")}`);
    const lines = hits.map((h) => {
      const alias = [h.name, h.enName].filter(Boolean).join(" / ");
      const dept = h.departments.length ? `；部门：${h.departments.join(" / ")}` : "";
      return `- ${alias} → open_id: ${h.openId}${dept}`;
    });
    return [
      "[人员提示] 本条消息按名字提到了以下成员（仅供你识别身份，不要复述本段）：",
      ...lines,
      '如需在回复中 @ 对方，可使用 <at id="对方open_id"></at>。',
    ].join("\n");
  }

  /**
   * 扫描文本，返回命中人员（按文中首次出现位置排序，按 openId 去重）。
   * 中文名子串匹配、英文名按词边界不区分大小写；名字长度 < 2 不参与。
   * 只扫前 SCAN_MAX_CHARS（1000）字，超长部分不参与匹配。
   */
  async match(text: string, opts: RosterMatchOptions = {}): Promise<RosterHit[]> {
    await this.ensureLoaded();
    if (!text || this.entries.length === 0) return [];

    const cleaned = text.replace(AT_TAG_RE, " ").slice(0, SCAN_MAX_CHARS);
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const hits: Array<RosterHit & { at: number }> = [];
    const seen = new Set<string>();

    for (const entry of this.entries) {
      if (opts.senderOpenId && entry.openId === opts.senderOpenId) continue;
      if (seen.has(entry.openId)) continue;

      let at = -1;
      if (entry.name.length >= MIN_NAME_CHARS) {
        at = cleaned.indexOf(entry.name);
      }
      if (at < 0 && entry.enName.length >= MIN_NAME_CHARS) {
        const m = new RegExp(`\\b${escapeRegExp(entry.enName)}\\b`, "i").exec(cleaned);
        at = m ? m.index : -1;
      }
      if (at < 0) continue;

      seen.add(entry.openId);
      hits.push({ openId: entry.openId, name: entry.name, enName: entry.enName, departments: entry.departments, at });
      if (hits.length >= limit) break;
    }
    return hits.sort((a, b) => a.at - b.at).map(({ at: _at, ...hit }) => hit);
  }

  /** 加载名单文件；mtime 变化时重载（文件由资料查询链路持续补充）。缺失/损坏按空名单。 */
  private async ensureLoaded(): Promise<void> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.usersFile)).mtimeMs;
    } catch {
      this.entries = [];
      this.loadedMtimeMs = -1;
      return;
    }
    if (mtimeMs === this.loadedMtimeMs) return;
    try {
      const parsed = JSON.parse(await readFile(this.usersFile, "utf8")) as Record<string, CachedProfile>;
      this.entries = Object.entries(parsed)
        .filter(([, p]) => Boolean(p && (p.name || p.en_name)))
        .map(([openId, p]) => ({
          openId,
          name: p.name ?? "",
          enName: p.en_name ?? "",
          departments: p.department_name ?? [],
        }));
      this.loadedMtimeMs = mtimeMs;
    } catch (error) {
      logger.warn(`[Roster] 名单文件解析失败，按空名单处理: ${error instanceof Error ? error.message : String(error)}`);
      this.entries = [];
      this.loadedMtimeMs = -1;
    }
  }
}
