/**
 * Meegle（飞书项目）Device Flow 授权：复用项目内 meegle CLI 的两阶段协议。
 *
 * 线协议（实测）：
 * - init：  meegle auth login --device-code --phase init --host <host>
 *           → { client_id, device_code, user_code, verification_uri_complete, expires_in, interval }
 * - poll：  meegle auth login --device-code --phase poll --device-code-value <code>
 *           --client-id <id> --host <host> --once
 *           → {"status":"authorization_pending"} | 成功时含 access_token
 *
 * 通过直接 spawn 项目内 meegle.js（node 跨平台），环境变量注入不走 shell。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.ts";

export const MEEGLE_HOST = "project.feishu.cn";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export interface MeegleDeviceBegin {
  clientId: string;
  deviceCode: string;
  userCode: string;
  /** 带 user_code 的完整授权链接（直接发给用户点击/扫码） */
  link: string;
  expiresInSec: number;
  intervalSec: number;
}

export type MeeglePollStatus = "pending" | "slow_down" | "success" | "expired" | "denied" | "error";

export interface MeeglePollResult {
  status: MeeglePollStatus;
  accessToken?: string;
  reason?: string;
}

/** 项目内 meegle.js 入口（缺失返回 undefined：node_modules 未安装等） */
export function resolveMeegleEntry(cwd: string): string | undefined {
  const path = join(cwd, "node_modules", "@lark-project", "meegle", "bin", "meegle.js");
  return existsSync(path) ? path : undefined;
}

type Run = (args: string[], timeoutMs: number) => Promise<string>;

function defaultRun(cwd: string): Run {
  return (args, timeoutMs) =>
    new Promise((resolve, reject) => {
      const entry = resolveMeegleEntry(cwd)!;
      const child = spawn(process.execPath, [entry, ...args], { windowsHide: true });
      let stdout = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`meegle 调用超时（${timeoutMs}ms）`));
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`meegle 退出码 ${code}：${stdout.slice(0, 200)}`));
      });
    });
}

function parseJsonLoose(stdout: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
}

/** 发起一次 Device Flow（init 阶段）。 */
export async function meegleDeviceBegin(opts: { cwd?: string; host?: string; run?: Run }): Promise<MeegleDeviceBegin> {
  const run = opts.run ?? defaultRun(opts.cwd ?? process.cwd());
  const out = await run(["auth", "login", "--device-code", "--phase", "init", "--host", opts.host ?? MEEGLE_HOST], 30_000);
  const data = parseJsonLoose(out);
  const clientId = str(data?.client_id);
  const deviceCode = str(data?.device_code);
  if (!clientId || !deviceCode) {
    throw new Error(str(data?.error_description) || str(data?.error) || "meegle 授权发起失败：响应缺少 device_code");
  }
  return {
    clientId,
    deviceCode,
    userCode: str(data?.user_code),
    link: str(data?.verification_uri_complete) || str(data?.verification_uri),
    expiresInSec: num(data?.expires_in) || 1800,
    intervalSec: num(data?.interval) || 5,
  };
}

/** 单次轮询（poll 阶段，--once 非阻塞）。调用方按 interval 自行循环。 */
export async function meegleDevicePollOnce(
  opts: { deviceCode: string; clientId: string; cwd?: string; host?: string; run?: Run },
): Promise<MeeglePollResult> {
  const run = opts.run ?? defaultRun(opts.cwd ?? process.cwd());
  const out = await run([
    "auth", "login", "--device-code", "--phase", "poll",
    "--device-code-value", opts.deviceCode,
    "--client-id", opts.clientId,
    "--host", opts.host ?? MEEGLE_HOST,
    "--once",
  ], 30_000).catch((error) => {
    logger.warn(`[MeegleAuth] 轮询调用失败：${error instanceof Error ? error.message : String(error)}`);
    return "{}";
  });
  const data = parseJsonLoose(out) ?? {};
  const accessToken = str(data.access_token) || str(data.token);
  if (accessToken) return { status: "success", accessToken };
  switch (str(data.status)) {
    case "authorization_pending": return { status: "pending" };
    case "slow_down": return { status: "slow_down" };
    case "expired_token": return { status: "expired", reason: "授权链接已过期" };
    case "access_denied": return { status: "denied", reason: "用户拒绝了授权" };
    default: {
      const reason = str(data.error_description) || str(data.error) || str(data.status) || "未知响应";
      return { status: "error", reason };
    }
  }
}
