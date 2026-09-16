/**
 * lark-cli 用户态搜索通道（contact +search-user --user-ids <open_id>）。
 *
 * 为什么需要它：通讯录 API 的部门字段（department_path 等）普遍需要管理员审核的
 * 敏感权限，个人开发者很难开通；而用户态的搜索接口（lark-cli contact +search-user）
 * 用**任意已 /login 用户的 user token** 即可按 open_id 反查，返回里自带现成的
 * 中文部门路径（如"自动驾驶研发部-系统工程交付部-基础功能部"），不依赖那两条需审核权限。
 *
 * 身份注入：与技能里的约定一致——通过环境变量 LARKSUITE_CLI_USER_ACCESS_TOKEN /
 * LARKSUITE_CLI_APP_ID 注入，token 不经过 shell，多用户并发互不可见。
 * 查询目标本人的 token 优先（查自己必然可见），其次管理员的 token。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.ts";
import type { ProfileName } from "./lark-cli.ts";

export interface CliSearchUserOptions {
  appId: string;
  /** 项目根（定位 node_modules 内的 lark-cli 原生二进制） */
  cwd?: string;
  /**
   * 查询用 user token 的候选 openId 列表（按优先级）：通常为 [目标本人, 管理员]。
   * 返回值里的 undefined 项跳过。
   */
  tokenCandidates: (targetOpenId: string) => Array<string | undefined>;
  /** 同步取某用户的有效 user token（读内存缓存，不触发刷新）；无则跳过该候选 */
  peekToken: (openId: string) => string | undefined;
  /** 单次 CLI 调用超时（毫秒），默认 20s */
  timeoutMs?: number;
  /** 测试注入：执行 lark-cli 并返回 stdout */
  run?: (exe: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<string>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 解析 contact +search-user 的 JSON 输出（容忍前后夹杂的非 JSON 提示行）。 */
export function parseSearchUserOutput(stdout: string): ProfileName | undefined {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      data = JSON.parse(stdout.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  const root = data as { ok?: unknown; data?: { users?: unknown } };
  if (root.ok === false) return undefined;
  const users = Array.isArray(root.data?.users)
    ? (root.data.users as unknown[])
    : root.data?.users && typeof root.data.users === "object"
      ? Object.values(root.data.users as Record<string, unknown>)
      : [];
  const user = (users[0] ?? {}) as Record<string, unknown>;
  const name = str(user.localized_name) || str(user.name) || undefined;
  const department = str(user.department).trim();
  if (!name && !department) return undefined;
  return {
    name,
    // 搜索接口不返回英文名
    department_name: department ? [department] : undefined,
  };
}

/** 解析失败/超时/非零退出都算未命中：调用方保留已有结果（通道语义） */
async function defaultRun(exe: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, windowsHide: true });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`lark-cli 调用超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`lark-cli 退出码 ${code}：${stdout.slice(0, 200)}`));
    });
  });
}

/** 项目内预制 lark-cli 的原生二进制路径（缺失返回 undefined：node_modules 未安装等） */
export function resolveLarkCliBinary(cwd: string): string | undefined {
  const ext = process.platform === "win32" ? ".exe" : "";
  const path = join(cwd, "node_modules", "@larksuite", "cli", "bin", `lark-cli${ext}`);
  return existsSync(path) ? path : undefined;
}

export type CliSearchUser = (targetOpenId: string) => Promise<ProfileName | undefined>;

export function createCliSearchUser(options: CliSearchUserOptions): CliSearchUser {
  const cwd = options.cwd ?? process.cwd();
  const run = options.run ?? defaultRun;
  const timeoutMs = options.timeoutMs ?? 20_000;

  return async (targetOpenId: string): Promise<ProfileName | undefined> => {
    const exe = resolveLarkCliBinary(cwd);
    if (!exe) {
      logger.warn("[CliSearch] 未找到项目内 lark-cli 二进制（node_modules/@larksuite/cli），跳过用户态搜索通道");
      return undefined;
    }
    for (const candidate of options.tokenCandidates(targetOpenId)) {
      if (!candidate) continue;
      const token = options.peekToken(candidate);
      if (!token) continue;
      try {
        const stdout = await run(exe, ["contact", "+search-user", "--user-ids", targetOpenId, "--as", "user"], {
          ...process.env,
          LARKSUITE_CLI_USER_ACCESS_TOKEN: token,
          LARKSUITE_CLI_APP_ID: options.appId,
        }, timeoutMs);
        const profile = parseSearchUserOutput(stdout);
        if (profile) {
          logger.info(`[CliSearch] 用户态搜索命中 ${targetOpenId}（以 ${candidate === targetOpenId ? "本人" : "管理员"} token 查询）：${profile.name ?? "无名"}, 部门=${profile.department_name?.join(" / ") ?? "无"}`);
          return profile;
        }
        logger.info(`[CliSearch] 用户态搜索未命中 ${targetOpenId}（以 ${candidate} token 查询）`);
      } catch (error) {
        logger.warn(`[CliSearch] 用户态搜索失败（${candidate} token）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return undefined;
  };
}
