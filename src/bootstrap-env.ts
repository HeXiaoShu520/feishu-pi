/**
 * 进程最早期的环境自举。必须在 `import "dotenv/config"` **之前**导入（ESM 按导入顺序执行），
 * 保证 dotenv 加载时 .env 与主密钥已就位：
 *
 * 1. .env 缺失时从 .env.example 拷贝一份——首次启动（或克隆后直接 npm start）不再因缺文件报错；
 * 2. MINICLAW_VAULT_KEY（加密凭证库主密钥）落 .env：
 *    - .env 已有合法密钥 → 直接使用；
 *    - 缺失但存在旧密钥文件（data/.vault-key）→ 把旧密钥迁入 .env（凭证数据不受影响），旧文件删除；
 *    - 两者皆无 → 生成新随机数写入 .env，并把无法解密的旧凭证数据清空（换钥即换锁，旧密文不可恢复）。
 */

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const VAULT_KEY = "MINICLAW_VAULT_KEY";
const HEX64 = /^[0-9a-fA-F]{64}$/;

/** 任务 0：.env 缺失时从 .env.example 拷贝。返回是否发生了拷贝。 */
export function ensureEnvFile(cwd: string): boolean {
  const envFile = join(cwd, ".env");
  const exampleFile = join(cwd, ".env.example");
  if (existsSync(envFile) || !existsSync(exampleFile)) return false;
  copyFileSync(exampleFile, envFile);
  console.log("[Bootstrap] 未检测到 .env，已从 .env.example 拷贝一份（请按需填写配置）。");
  return true;
}

/** .env 文本中读取 MINICLAW_VAULT_KEY（合法 hex64 才算数）。 */
function readKeyFromEnvContent(content: string): string | undefined {
  const match = content.match(new RegExp(`^${VAULT_KEY}=([0-9a-fA-F]{64})\\s*$`, "m"));
  return match?.[1];
}

/** 把键值追加写入 .env（无文件则创建），并同步进 process.env。 */
function writeKeyToEnvFile(envFile: string, key: string, env: NodeJS.ProcessEnv): void {
  const existing = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  if (readKeyFromEnvContent(existing) === key) {
    env[VAULT_KEY] = key;
    return;
  }
  const base = existing ? `${existing.replace(/\n*$/, "\n")}` : "";
  writeFileSync(envFile, `${base}${VAULT_KEY}=${key}\n`, "utf8");
  env[VAULT_KEY] = key;
}

/**
 * 任务 7：确保 MINICLAW_VAULT_KEY 存在于 .env（唯一密钥来源，便于备份迁移）。
 * 无任何可用密钥时生成新随机数，并清空旧密钥加密的凭证数据（不可解密即无用，留着只会误导）。
 */
export function ensureVaultKeyInEnv(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const envFile = join(cwd, ".env");
  const dataDir = join(cwd, "data");

  const inEnv = (env[VAULT_KEY] ?? "").trim();
  if (HEX64.test(inEnv)) return; // 已有合法密钥（含此前写入过的）：直接使用

  const content = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const inFile = readKeyFromEnvContent(content);
  if (inFile) {
    env[VAULT_KEY] = inFile; // .env 有但未加载（理论上不会）：补进环境即可
    return;
  }

  // 生成新密钥；已存在的凭证数据因此无法解密，按约定清空
  const credentialsDir = join(dataDir, "credentials");
  const legacyVault = join(dataDir, "credentials.vault.json");
  if (existsSync(credentialsDir) || existsSync(legacyVault)) {
    rmSync(credentialsDir, { recursive: true, force: true });
    rmSync(legacyVault, { force: true });
    console.warn("[Bootstrap] 未找到主密钥，已生成新密钥写入 .env；旧凭证数据无法解密，已清空（需重新 /login）。");
  } else {
    console.log("[Bootstrap] 已生成加密凭证库主密钥并写入 .env（MINICLAW_VAULT_KEY）。");
  }
  writeKeyToEnvFile(envFile, randomBytes(32).toString("hex"), env);
}

/** 进程入口调用：按顺序执行两项自举。 */
export function runBootstrap(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  ensureEnvFile(cwd);
  ensureVaultKeyInEnv(cwd, env);
}

// 以模块副作用执行：main.ts 把本模块作为第一个 import，保证自举先于 dotenv/config。
// 测试环境（vitest）下仅为取纯函数，跳过自举以免触碰真实 .env / data。
if (!process.env.VITEST && !process.env.NODE_TEST_CONTEXT) {
  runBootstrap(process.cwd());
}
