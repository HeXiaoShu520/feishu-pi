import { readFile, stat } from "node:fs/promises";
import { compileRules, type PermissionRule, type PermissionFields } from "./rules.ts";
import { logger } from "../utils/logger.ts";

/** A personal policy has no users, roles or team membership. */
export interface ToolPolicy {
  valid: boolean;
  bashAllowed(command: string): boolean;
  readAllowed(path: string): boolean;
  writeAllowed(path: string): boolean;
  toolsAllowed(name: string): boolean;
  denied(toolName: string, args: unknown): string | undefined;
  asked(toolName: string, args: unknown): string | undefined;
  describe(): Required<PermissionFields>;
}

export interface PermissionOverview { allow: string[]; ask: string[]; deny: string[]; valid: boolean }
export const SHELL_META = /[;&|`$<>\\()\r\n]/;

export class PermissionPolicy {
  private rules = { allow: [] as PermissionRule[], ask: [] as PermissionRule[], deny: [] as PermissionRule[] };
  private mtimeMs = -1;
  private valid = false;
  private loading?: Promise<void>;
  private readonly cwd: string;
  private readonly filePath: string;

  constructor(filePath: string, options: { cwd?: string } = {}) { this.filePath = filePath; this.cwd = options.cwd ?? process.cwd(); }
  async preload(): Promise<void> { await this.ensureLoaded(); }

  async current(): Promise<ToolPolicy> {
    await this.ensureLoaded();
    const { allow, ask, deny } = this.rules;
    const matching = (rules: PermissionRule[], name: string, args: unknown) => rules.find((rule) => rule.matches(name, args, this.cwd))?.raw;
    const fields: Required<PermissionFields> = { bash: [], read: [], write: [], tools: [] };
    for (const rule of allow) fields[rule.kind].push(rule.pattern);
    return {
      valid: this.valid,
      bashAllowed: (command) => !SHELL_META.test(command) && Boolean(matching(allow, "bash", { command })),
      readAllowed: (path) => Boolean(matching(allow, "read", { path })),
      writeAllowed: (path) => Boolean(matching(allow, "write", { path })),
      toolsAllowed: (name) => Boolean(matching(allow, name, {})),
      denied: (name, args) => matching(deny, name, args),
      asked: (name, args) => matching(ask, name, args),
      describe: () => fields,
    };
  }

  async describe(): Promise<PermissionOverview> {
    await this.ensureLoaded();
    return {
      allow: this.rules.allow.map((rule) => rule.raw), ask: this.rules.ask.map((rule) => rule.raw),
      deny: this.rules.deny.map((rule) => rule.raw), valid: this.valid,
    };
  }

  private async ensureLoaded(): Promise<void> {
    this.loading ??= this.reload().finally(() => { this.loading = undefined; });
    await this.loading;
  }

  private async reload(): Promise<void> {
    try {
      const mtime = (await stat(this.filePath)).mtimeMs;
      if (mtime === this.mtimeMs) return;
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, unknown>;
      // Only the old owner's allow list is adopted. Team permissions are never merged.
      const legacy = raw.allow && !Array.isArray(raw.allow) && typeof raw.allow === "object";
      const allow = legacy ? (raw.allow as Record<string, unknown>).admin : raw.allow;
      const next = { allow: compileRules(allow), ask: compileRules(raw.ask), deny: compileRules(raw.deny) };
      this.rules = next;
      this.mtimeMs = mtime;
      this.valid = true;
      if (legacy) logger.warn("[Policy] 旧 admin 白名单已按个人策略读取，请迁移为 allow 数组；group 不再使用");
      logger.info(`[Policy] allow(${next.allow.length}) ask(${next.ask.length}) deny(${next.deny.length})`);
    } catch (error) {
      this.rules = { allow: [], ask: [], deny: [] };
      this.valid = false;
      this.mtimeMs = -1;
      logger.warn(`[Policy] 权限配置不可用，所有调用拒绝: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
