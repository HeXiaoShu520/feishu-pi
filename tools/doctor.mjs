import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "dotenv";

const cwd = process.cwd();
let failed = false;
function check(ok, name, hint) {
  console.log(`${ok ? "OK" : "FAIL"} ${name}${ok || !hint ? "" : ` — ${hint}`}`);
  failed ||= !ok;
}
check(Number(process.versions.node.split(".")[0]) >= 22, "Node.js 22+", "安装 Node.js 22 或更新版本");
check(existsSync(join(cwd, "node_modules", "tsx")), "npm 依赖", "先运行 npm ci");
const envFile = join(cwd, ".env");
const env = { ...(existsSync(envFile) ? parse(readFileSync(envFile)) : {}), ...process.env };
const python = spawnSync(env.FEISHU_STICKER_PYTHON || "python", ["-c", "from PIL import Image; print('ready')"],
  { encoding: "utf8", timeout: 15000, windowsHide: true });
check(python.status === 0, "Python + Pillow（表情预览）", "python -m pip install -r requirements-stickers.txt；自定义 Python 路径见 .env.example");
let images = 0;
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) walk(join(dir, item.name));
    else if (/\.(?:gif|png|jpe?g|webp)$/iu.test(item.name)) images++;
  }
}
for (const pack of ["clawd", "whale-girl"]) {
  const dir = join(cwd, "stickers", pack);
  check(existsSync(join(dir, "metadata.json")), `内置图库 ${pack}`, "请完整克隆本分支，保留 stickers 目录");
}
walk(join(cwd, "stickers"));
check(images > 0, `内置表情原图（${images} 张）`, "当前副本缺少原图，仅描述文件不能发送表情");
check(existsSync(join(cwd, ".agent", "SYSTEM.md")), "默认人格", "缺少 .agent/SYSTEM.md");
if (!process.argv.includes("--no-config")) {
  check(existsSync(envFile), ".env 配置", "先运行 npm run setup；或复制 .env.example 为 .env");
  for (const name of ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_PI_OWNER", "FEISHU_PI_MODEL_NAME", "FEISHU_PI_MODEL_BASE_URL", "FEISHU_PI_MODEL_API_KEY"]) {
    check(Boolean(env[name]?.trim()), name, "请在本机 .env 填写；不会输出配置值");
  }
  check(/^ou_[A-Za-z0-9_-]+$/u.test(env.FEISHU_PI_OWNER || ""), "管理员 Open ID 格式", "使用当前机器人应用对应的 ou_... 用户 ID");
  try {
    const url = new URL(env.FEISHU_PI_MODEL_BASE_URL);
    check(["https:", "http:"].includes(url.protocol), "模型接口地址格式", "填写 http(s) 地址");
  } catch { check(false, "模型接口地址格式", "填写 http(s) 地址"); }
}
console.log(failed ? "检查未通过。按上面的提示修复后重试。" : "本地依赖和资源检查通过。接口鉴权、视觉能力与飞书发布状态请在实际聊天中验证。");
process.exitCode = failed ? 1 : 0;
