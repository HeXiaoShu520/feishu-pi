/** 仅供消息预处理使用：真实 @ 提及时，以管理员用户身份补全被 @ 者资料。 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.ts";
import type { ProfileName } from "./lark-cli.ts";

interface MentionLookupOptions {
  cwd: string;
  appId: string;
  adminOpenId?: string;
  getAdminToken: (openId: string) => Promise<string | undefined>;
}

function parseProfile(output: string): ProfileName | undefined {
  let root: { ok?: boolean; data?: { users?: unknown } };
  try {
    root = JSON.parse(output) as typeof root;
  } catch {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try { root = JSON.parse(output.slice(start, end + 1)) as typeof root; }
    catch { return undefined; }
  }
  if (root.ok === false) return undefined;
  const users = Array.isArray(root.data?.users)
    ? root.data.users
    : root.data?.users && typeof root.data.users === "object"
      ? Object.values(root.data.users as Record<string, unknown>)
      : [];
  const user = (users[0] ?? {}) as Record<string, unknown>;
  const name = typeof user.localized_name === "string" ? user.localized_name :
    typeof user.name === "string" ? user.name : "";
  const department = typeof user.department === "string" ? user.department.trim() : "";
  if (!name && !department) return undefined;
  return { name: name || undefined, department_name: department ? [department] : undefined };
}

export function createMentionProfileLookup(options: MentionLookupOptions): (mentionedOpenId: string) => Promise<ProfileName | undefined> {
  return async (mentionedOpenId) => {
    // 只接受飞书 Open ID；调用方只从消息的 mentions 列表传入。
    if (!/^ou_[A-Za-z0-9_-]+$/.test(mentionedOpenId) || !options.adminOpenId) return undefined;
    const token = await options.getAdminToken(options.adminOpenId);
    if (!token) return undefined;
    const exe = join(options.cwd, "node_modules", "@larksuite", "cli", "bin", `lark-cli${process.platform === "win32" ? ".exe" : ""}`);
    if (!existsSync(exe)) return undefined;
    const env = { ...process.env };
    delete env.FEISHU_APP_ID;
    delete env.FEISHU_APP_SECRET;
    delete env.LARKSUITE_CLI_APP_SECRET;
    delete env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN;
    env.LARKSUITE_CLI_USER_ACCESS_TOKEN = token;
    env.LARKSUITE_CLI_APP_ID = options.appId;
    env.LARKSUITE_CLI_CONFIG_DIR = join(options.cwd, "data", "lark-cli-runtime");
    env.LARKSUITE_CLI_BRAND = "feishu";
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(exe, ["contact", "+search-user", "--user-ids", mentionedOpenId, "--as", "user"], { env, windowsHide: true });
      let stdout = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("资料查询超时")); }, 20_000);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`资料查询退出码 ${code}`));
      });
    }).catch((error) => {
      logger.warn(`[MentionLookup] @ 用户资料查询失败：${error instanceof Error ? error.message : String(error)}`);
      return "";
    });
    return output ? parseProfile(output) : undefined;
  };
}
