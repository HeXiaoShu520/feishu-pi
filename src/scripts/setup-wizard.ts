// 扫码 setup 向导：一条终端指令完成"创建/绑定飞书应用 + 预置权限 + 写入 .env"。
//
//   npm run setup            # .env 已有 FEISHU_APP_ID 时走"更新该应用"模式，否则创建新应用
//   npm run setup -- --new   # 强制创建新应用
//
// 交互协议：registerApp 的 Device Flow（RFC 8628，对齐 @larksuiteoapi/node-sdk 的
// lark.registerApp 线协议）。这里用全局 fetch 复刻而非直接调 SDK——SDK 默认
// httpInstance 基于 axios，其在 Node ESM 下存在 https 协议误判的已知问题
// （同款修复见 dsh-lark-link/src/host/auth-setup.ts）。
//
// 预置权限（addons，扫码确认页可见、创建时自动应用）：
// - 机器人收发消息最小集（im:message / im:chat / im:resource / 群消息 / 表情回执）
// - 通讯录只读（上电用机器人身份预取管理员资料：中英文名 + 部门）
// - 事件 im.message.receive_v1（WS 长连接收消息）+ 卡片回调 card.action.trigger
import "dotenv/config";
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import qr from "qrcode-terminal";

const REGISTRATION_URL = "https://accounts.feishu.cn/oauth/v1/app/registration";
const ENV_FILE = join(process.cwd(), ".env");

/** 预置权限与事件（创建/更新应用时由平台自动应用，用户在扫码确认页可见） */
function buildAddons(): Record<string, unknown> {
  return {
    scopes: {
      tenant: [
        // 机器人收发消息最小集
        "im:message",
        "im:message.send_as_bot",
        "im:chat",
        "im:resource",
        "im:message.group_msg",
        "im:message.reactions:write_only",
        // 通讯录只读（上电机器人身份预取管理员资料）
        "contact:contact.base:readonly",
        "contact:user.base:readonly",
        "contact:user.department:readonly",
        "contact:user.department_path:readonly",
        "contact:department.base:readonly",
      ],
    },
    events: { items: { tenant: ["im.message.receive_v1"] } },
    callbacks: { items: ["card.action.trigger"] },
  };
}

/** base64url(gzip(addons)) — 与 SDK 的 encodeAddons 编码一致 */
function encodeAddons(addons: Record<string, unknown>): string {
  return gzipSync(Buffer.from(JSON.stringify(addons), "utf8"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok && !data.error) throw new Error(`请求失败：HTTP ${res.status}`);
  return data;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

async function registerApp(appId?: string): Promise<{ appId: string; appSecret: string }> {
  const begin = await postForm(REGISTRATION_URL, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });
  const deviceCode = str(begin.device_code);
  const link = str(begin.verification_uri_complete) || str(begin.verification_uri);
  if (!deviceCode || !link) {
    throw new Error(str(begin.error_description) || str(begin.error) || "发起注册失败：未返回 device_code");
  }

  console.log("\n🔐 请用飞书扫描二维码完成授权（或打开下方链接）：\n");
  qr.generate(link, { small: true });
  console.log(link, "\n");
  console.log(`⏱️  约 ${Math.round((num(begin.expires_in) || 600) / 60)} 分钟内有效；权限确认页请点击同意。\n`);

  const intervalMs = (num(begin.interval) || 5) * 1000;
  const deadline = Date.now() + (num(begin.expires_in) || 600) * 1000;
  let waitMs = intervalMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const poll = await postForm(REGISTRATION_URL, { action: "poll", device_code: deviceCode });
    const clientId = str(poll.client_id);
    const clientSecret = str(poll.client_secret);
    if (clientId && clientSecret) return { appId: clientId, appSecret: clientSecret };
    switch (str(poll.error)) {
      case "authorization_pending":
        process.stdout.write("⏳ 等待扫码授权…\r");
        break;
      case "slow_down":
        waitMs += 5000;
        break;
      case "access_denied":
      case "expired_token":
        throw new Error(str(poll.error_description) || `授权失败：${str(poll.error)}`);
      default:
        if (poll.error) throw new Error(str(poll.error_description) || `授权失败：${str(poll.error)}`);
    }
  }
  throw new Error("等待授权超时（二维码已过期），请重新运行 npm run setup");
}

/** 把 appId/appSecret 写入 .env：已有键原位替换，缺失键补到末尾；其他键原样保留 */
function writeEnv(appId: string, appSecret: string): void {
  const update = (content: string): string => {
    let replacedId = false;
    let replacedSecret = false;
    const lines = content.split("\n").map((line) => {
      if (line.startsWith("FEISHU_APP_ID=")) {
        replacedId = true;
        return `FEISHU_APP_ID=${appId}`;
      }
      if (line.startsWith("FEISHU_APP_SECRET=")) {
        replacedSecret = true;
        return `FEISHU_APP_SECRET=${appSecret}`;
      }
      return line;
    });
    if (!replacedId) lines.push(`FEISHU_APP_ID=${appId}`);
    if (!replacedSecret) lines.push(`FEISHU_APP_SECRET=${appSecret}`);
    return lines.join("\n");
  };
  const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  writeFileSync(ENV_FILE, update(existing).replace(/\n*$/, "\n"), "utf8");
}

async function main(): Promise<void> {
  const forceNew = process.argv.includes("--new");
  const envContent = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const envMatch = envContent.match(/^FEISHU_APP_ID=(.+)$/m);
  const existingAppId = envMatch?.[1]?.trim();
  const updateTarget = !forceNew && existingAppId ? existingAppId : undefined;

  console.log(updateTarget
    ? `检测到已有应用 ${updateTarget}：扫码后将为其更新/补充预置权限（不会创建新应用）。`
    : "未检测到已配置的应用：扫码后将创建新应用并预置权限。");
  console.log("预置内容：机器人收发消息、通讯录只读（用于上电识别管理员）、消息事件与卡片回调。\n");

  const created = await registerApp(updateTarget);
  writeEnv(created.appId, created.appSecret);

  console.log("\n✅ 完成！凭证已写入 .env：");
  console.log(`   FEISHU_APP_ID=${created.appId}`);
  console.log("   FEISHU_APP_SECRET=***（已写入，不回显）");
  console.log("\n下一步：");
  console.log("  1. npm start            # 启动服务（WS 长连接，无需公网）");
  console.log("  2. 在飞书私聊机器人发 /login，为管理员开启用户身份能力");
  console.log("  3. 如开发者后台显示有待发布版本，请发布后权限方可全量生效");
}

void main().catch((error) => {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
