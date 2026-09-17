/**
 * 进程最早期的环境自举。必须在 `import "dotenv/config"` **之前**导入（ESM 按导入顺序执行），
 * 保证 dotenv 加载时 .env 已就位：.env 缺失时从 .env.example 拷贝一份——
 * 首次启动（或克隆后直接 npm start）不再因缺文件报错。
 *
 * 加密凭证库主密钥不在这里管：它独立存放于 data/.vault-key 密钥文件，
 * 由 CredentialVault 首次打开时自动生成（与 .env 解耦，避免密钥混进环境配置）。
 */

import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** .env 缺失时从 .env.example 拷贝。返回是否发生了拷贝。 */
export function ensureEnvFile(cwd: string): boolean {
  const envFile = join(cwd, ".env");
  const exampleFile = join(cwd, ".env.example");
  if (existsSync(envFile) || !existsSync(exampleFile)) return false;
  copyFileSync(exampleFile, envFile);
  console.log("[Bootstrap] 未检测到 .env，已从 .env.example 拷贝一份（请按需填写配置）。");
  return true;
}

/** 进程入口调用：执行自举。 */
export function runBootstrap(cwd: string): void {
  ensureEnvFile(cwd);
}

// 以模块副作用执行：main.ts 把本模块作为第一个 import，保证自举先于 dotenv/config。
// 测试环境（vitest）下仅为取纯函数，跳过自举以免触碰真实 .env。
if (!process.env.VITEST && !process.env.NODE_TEST_CONTEXT) {
  runBootstrap(process.cwd());
}
