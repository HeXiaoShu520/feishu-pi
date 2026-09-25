/**
 * Meegle（飞书项目）Device Flow 授权：复用项目内 meegle CLI 的两阶段协议。
 *
 * 线协议（实测）：
 * - init：  meegle auth login --device-code --phase init --host <host>
 *           → { client_id, device_code, user_code, verification_uri_complete, expires_in, interval }
 * - poll：直接调用服务端 OAuth token endpoint，避免 CLI 将成功令牌只写入
 *   进程级凭据区并仅输出 {"status":"ok"}，导致机器人无法按用户保存令牌。
 *
 * init 通过直接 spawn 项目内 meegle.js；poll 使用 OAuth HTTP 接口，均不走 shell。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const MEEGLE_HOST = "project.feishu.cn";
let cachedTokenEndpoint: string | undefined;

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
      const env = { ...process.env };
      delete env.MEEGLE_USER_ACCESS_TOKEN;
      const child = spawn(process.execPath, [entry, ...args], { windowsHide: true, env });
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

/** 单次非阻塞轮询。调用方按 interval 自行循环。 */
export async function meegleDevicePollOnce(
  opts: { deviceCode: string; clientId: string; host?: string; fetcher?: typeof fetch },
): Promise<MeeglePollResult> {
  const fetcher = opts.fetcher ?? fetch;
  const host = opts.host ?? MEEGLE_HOST;
  if (host !== MEEGLE_HOST) throw new Error("不支持的 Meegle 授权站点");
  let endpoint = opts.fetcher ? undefined : cachedTokenEndpoint;
  if (!endpoint) {
    const metadataResponse = await fetcher(`https://${host}/.well-known/oauth-authorization-server`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!metadataResponse.ok) throw new Error(`Meegle OAuth 发现失败：HTTP ${metadataResponse.status}`);
    const metadata = await metadataResponse.json() as { token_endpoint?: string };
    endpoint = metadata.token_endpoint;
  }
  const endpointUrl = endpoint ? new URL(endpoint) : undefined;
  if (!endpointUrl || endpointUrl.protocol !== "https:" ||
      (endpointUrl.hostname !== host && !endpointUrl.hostname.endsWith(".feishu.cn"))) {
    throw new Error("Meegle OAuth token endpoint 无效");
  }
  if (!opts.fetcher) cachedTokenEndpoint = endpointUrl.toString();
  const response = await fetcher(endpointUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: opts.deviceCode,
      client_id: opts.clientId,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.json() as Record<string, unknown>;
  const data = (raw.data && typeof raw.data === "object" ? raw.data : raw) as Record<string, unknown>;
  const accessToken = str(data.access_token) || str(data.token);
  if (accessToken) return { status: "success", accessToken };
  switch (str(data.error) || str(data.status)) {
    case "authorization_pending": return { status: "pending" };
    case "slow_down": return { status: "slow_down" };
    case "expired_token": return { status: "expired", reason: "授权链接已过期" };
    case "access_denied": return { status: "denied", reason: "用户拒绝了授权" };
    case "ok": return { status: "error", reason: "授权已完成，但服务端未返回令牌" };
    default: {
      const reason = str(data.error_description) || str(data.error) || str(data.status) || `HTTP ${response.status}`;
      return { status: "error", reason };
    }
  }
}
