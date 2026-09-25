import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { createHistoryCardReader } from "../feishu/history-card-reader.ts";
import { enrichFeishuHistory, isFeishuHistoryRead } from "../feishu/history-card-content.ts";
import { LarkCli } from "../feishu/lark-cli.ts";

export interface CliProxyOptions {
  cwd: string;
  appId: string;
  appSecret: string;
  botOpenId?: string;
  botName?: string;
  getLarkToken?: () => Promise<string | undefined>;
  onLarkMissing?: () => void;
  onLarkOutput?: (output: string) => string | undefined;
  getMeegleToken?: () => string | undefined;
  meegleEnv?: Record<string, string>;
  /** 管理员凭证只用于固定的资料入库流程，不供 AI 的 CLI 调用使用。 */
  adminSender?: boolean;
}

export interface CliProxyHandle {
  port: number;
  key: string;
  configDir: string;
  close: () => Promise<void>;
}

const send = (response: ServerResponse, frame: object): void => {
  if (!response.writableEnded && !response.destroyed) response.write(`${JSON.stringify(frame)}\n`);
};
const writeText = (response: ServerResponse, stream: "stdout" | "stderr", text: string): void => {
  send(response, { stream, data: Buffer.from(text).toString("base64") });
};

function isBot(args: string[]): boolean {
  return args.some((arg, index) => arg === "--as=bot" || (arg === "--as" && args[index + 1] === "bot"));
}

/** 每次 bash 调用独立的本地通道；shell 只拿随机句柄，不接触用户 token 或应用密钥。 */
export async function startCliProxy(options: CliProxyOptions): Promise<CliProxyHandle> {
  const key = randomBytes(32).toString("hex");
  const configDir = await mkdtemp(join(tmpdir(), "mini-claw-cli-"));
  const children = new Set<ChildProcess>();
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    const supplied = request.headers["x-feishu-pi-key"];
    const candidate = typeof supplied === "string" ? supplied : "";
    if (request.method !== "POST" || request.url !== "/invoke" || candidate.length !== key.length ||
      !timingSafeEqual(Buffer.from(candidate), Buffer.from(key))) {
      writeText(response, "stderr", "CLI 身份通道拒绝访问\n");
      send(response, { exitCode: 1 });
      response.end();
      return;
    }

    try {
      let body = "";
      for await (const part of request) {
        body += part.toString("utf8");
        if (body.length > 1_000_000) throw new Error("CLI 参数过长");
      }
      const input = JSON.parse(body) as { kind?: unknown; args?: unknown; cwd?: unknown };
      if ((input.kind !== "lark" && input.kind !== "meegle") || !Array.isArray(input.args) ||
        input.args.some((value) => typeof value !== "string") || typeof input.cwd !== "string") {
        throw new Error("CLI 参数无效");
      }
      const kind = input.kind;
      const args = input.args as string[];
      const historyRead = kind === "lark" && isFeishuHistoryRead(args);
      if (options.adminSender && (kind === "meegle" || !isBot(args))) {
        throw new Error("管理员用户凭证只用于固定资料入库流程，AI 命令不可使用。飞书机器人权限操作请显式指定 --as bot");
      }
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const name of [
        "LARKSUITE_CLI_USER_ACCESS_TOKEN", "LARKSUITE_CLI_TENANT_ACCESS_TOKEN",
        "LARKSUITE_CLI_APP_ID", "LARKSUITE_CLI_APP_SECRET", "LARKSUITE_CLI_CONFIG_DIR",
        "FEISHU_APP_ID", "FEISHU_APP_SECRET", "MEEGLE_USER_ACCESS_TOKEN",
        "FEISHU_PI_CLI_PROXY_PORT", "FEISHU_PI_CLI_PROXY_KEY",
      ]) delete env[name];

      let executable: string;
      let childArgs: string[];
      let historyUserToken: string | undefined;
      if (kind === "lark") {
        const businessArgs = args[0] === "--as" ? args.slice(2) : /^--as=/.test(args[0] ?? "") ? args.slice(1) : args;
        if (businessArgs[0] === "auth") {
          throw new Error("请使用飞书 /status 或 /login 管理授权，不调用 lark-cli auth");
        }
        if (businessArgs[0] === "contact" && businessArgs[1] === "+search-user") {
          throw new Error("@ 人资料由消息预处理自动查询，不由 AI 调用 contact +search-user");
        }
        executable = join(options.cwd, "node_modules", "@larksuite", "cli", "bin", `lark-cli${process.platform === "win32" ? ".exe" : ""}`);
        childArgs = args;
        env.LARKSUITE_CLI_CONFIG_DIR = configDir;
        env.LARKSUITE_CLI_BRAND = "feishu";
        env.LARKSUITE_CLI_APP_ID = options.appId;
        if (isBot(args)) {
          env.LARKSUITE_CLI_APP_SECRET = options.appSecret;
        } else {
          const token = await options.getLarkToken?.();
          if (!token) {
            options.onLarkMissing?.();
            throw new Error("当前发消息者尚未完成飞书授权，已发送登录卡片；不会使用本机账号");
          }
          env.LARKSUITE_CLI_USER_ACCESS_TOKEN = token;
          historyUserToken = token;
        }
      } else {
        if (args[0] === "auth") throw new Error("请使用 Meegle /login 管理授权，不调用 meegle auth");
        const token = options.getMeegleToken?.();
        if (!token) throw new Error("当前发消息者尚未完成 Meegle 授权，已发送登录卡片；不会使用本机账号");
        const entry = join(options.cwd, "node_modules", "@lark-project", "meegle", "bin", "meegle.js");
        executable = process.execPath;
        childArgs = [entry, ...args];
        env.MEEGLE_USER_ACCESS_TOKEN = token;
        for (const [name, value] of Object.entries(options.meegleEnv ?? {})) env[name] = value;
      }
      if (kind === "lark" && !existsSync(executable)) throw new Error("项目内 lark-cli 未安装");
      if (kind === "meegle" && !existsSync(childArgs[0])) throw new Error("项目内 meegle 未安装");

      const child = spawn(executable, childArgs, { cwd: input.cwd, env, windowsHide: true });
      children.add(child);
      let observed = "";
      const buffered: Buffer[] = [];
      let bufferedBytes = 0;
      let captureHistory = historyRead;
      const observe = (data: Buffer): void => {
        if (observed.length < 100_000) observed += data.toString("utf8").slice(0, 100_000 - observed.length);
      };
      const forward = (stream: "stdout" | "stderr", data: Buffer): void => {
        send(response, { stream, data: data.toString("base64") });
        observe(data);
      };
      child.stdout?.on("data", (data: Buffer) => {
        if (!captureHistory) { forward("stdout", data); return; }
        observe(data);
        bufferedBytes += data.length;
        buffered.push(data);
        if (bufferedBytes > 8 * 1024 * 1024) {
          captureHistory = false;
          writeText(response, "stderr", "历史结果超过 8 MiB，本次无法补取卡片原文；请缩小时间范围或分页读取。\n");
          for (const chunk of buffered) send(response, { stream: "stdout", data: chunk.toString("base64") });
          buffered.length = 0;
        }
      });
      child.stderr?.on("data", (data: Buffer) => forward("stderr", data));
      response.on("close", () => { if (!response.writableEnded) child.kill(); });
      child.on("error", (error) => {
        writeText(response, "stderr", `${error.message}\n`);
      });
      child.on("close", (code) => { void (async () => {
        children.delete(child);
        if (captureHistory) {
          const output = Buffer.concat(buffered).toString("utf8");
          let readable = output;
          if (code === 0 && output.trim()) {
            try {
              const fetchCard = createHistoryCardReader({
                cwd: options.cwd,
                appId: options.appId,
                appSecret: options.appSecret,
                botOpenId: options.botOpenId,
                userToken: historyUserToken,
              });
              const profiles = new LarkCli(options.appId, join(options.cwd, "data", "users"));
              readable = await enrichFeishuHistory(output, fetchCard, async (senderId, senderType) => {
                if (senderType === "app") {
                  return senderId === options.botOpenId || senderId === options.appId ? options.botName || "机器人" : "其他机器人";
                }
                if (!senderId.startsWith("ou_")) return undefined;
                const profile = await profiles.getUserProfile(senderId);
                return profile.name || profile.en_name || undefined;
              });
            } catch {
              readable = output;
            }
          }
          writeText(response, "stdout", readable);
        }
        if (kind === "lark" && !isBot(args)) {
          try {
            const note = options.onLarkOutput?.(observed);
            if (note) writeText(response, "stderr", `\n${note}\n`);
          } catch {
            writeText(response, "stderr", "授权提示处理失败，请使用 /login 检查当前账号\n");
          }
        }
        send(response, { exitCode: code ?? 1 });
        response.end();
      })().catch((error) => {
        writeText(response, "stderr", `历史内容整理失败：${error instanceof Error ? error.message : String(error)}\n`);
        send(response, { exitCode: code ?? 1 });
        response.end();
      }); });
    } catch (error) {
      writeText(response, "stderr", `${error instanceof Error ? error.message : String(error)}\n`);
      send(response, { exitCode: 1 });
      response.end();
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch (error) {
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error("CLI 身份通道监听失败");
  }
  return {
    port: address.port,
    key,
    configDir,
    close: async () => {
      for (const child of children) child.kill();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const rel = relative(resolve(tmpdir()), resolve(configDir));
      if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !/^[\\/]/.test(rel)) {
        await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
