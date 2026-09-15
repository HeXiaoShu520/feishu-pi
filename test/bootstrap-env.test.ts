import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureEnvFile, ensureVaultKeyInEnv } from "../src/bootstrap-env.ts";

const HEX64 = "a".repeat(64);
const OTHER_HEX64 = "b".repeat(64);

describe("ensureEnvFile（.env 缺失自动拷贝）", () => {
  it("无 .env 且有 .env.example → 拷贝一份", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boot-"));
    await writeFile(join(dir, ".env.example"), "FEISHU_APP_ID=\n", "utf8");
    expect(ensureEnvFile(dir)).toBe(true);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("FEISHU_APP_ID=\n");
  });

  it("已有 .env → 不覆盖；无 .env.example → 不动作", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boot-"));
    await writeFile(join(dir, ".env"), "MINICLAW_VAULT_KEY=x\n", "utf8");
    expect(ensureEnvFile(dir)).toBe(false);
    expect((await readFile(join(dir, ".env"), "utf8")).includes("MINICLAW_VAULT_KEY")).toBe(true);

    const empty = await mkdtemp(join(tmpdir(), "boot-"));
    expect(ensureEnvFile(empty)).toBe(false);
  });
});

describe("ensureVaultKeyInEnv（主密钥落 .env）", () => {
  it("process.env 已有合法密钥 → 原样使用，不动 .env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bootkey-"));
    const env = { MINICLAW_VAULT_KEY: HEX64 };
    ensureVaultKeyInEnv(dir, env as NodeJS.ProcessEnv);
    expect(env.MINICLAW_VAULT_KEY).toBe(HEX64);
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it(".env 已有密钥但环境未加载 → 补进环境", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bootkey-"));
    await writeFile(join(dir, ".env"), `MINICLAW_VAULT_KEY=${OTHER_HEX64}\n`, "utf8");
    const env = {} as NodeJS.ProcessEnv;
    ensureVaultKeyInEnv(dir, env);
    expect(env.MINICLAW_VAULT_KEY).toBe(OTHER_HEX64);
  });

  it("无任何密钥但存在凭证数据 → 生成新密钥写入 .env 并清空旧凭证", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bootkey-"));
    const dataDir = join(dir, "data");
    await mkdir(join(dataDir, "credentials"), { recursive: true });
    await writeFile(join(dataDir, "credentials", "lark.vault.json"), "{}", "utf8");
    await writeFile(join(dataDir, "credentials.vault.json"), "{}", "utf8");

    const env = {} as NodeJS.ProcessEnv;
    ensureVaultKeyInEnv(dir, env);
    expect(env.MINICLAW_VAULT_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(env.MINICLAW_VAULT_KEY).not.toBe(HEX64);
    expect((await readFile(join(dir, ".env"), "utf8")).includes("MINICLAW_VAULT_KEY=")).toBe(true);
    expect(existsSync(join(dataDir, "credentials"))).toBe(false);
    expect(existsSync(join(dataDir, "credentials.vault.json"))).toBe(false);
  });

  it("全新环境（无密钥无凭证）→ 生成密钥写 .env，无清理动作", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bootkey-"));
    const env = {} as NodeJS.ProcessEnv;
    ensureVaultKeyInEnv(dir, env);
    expect(env.MINICLAW_VAULT_KEY).toMatch(/^[0-9a-f]{64}$/);
    await expect(readFile(join(dir, ".env"), "utf8")).resolves.toContain(`MINICLAW_VAULT_KEY=${env.MINICLAW_VAULT_KEY}`);
    // 再次执行：幂等（不换钥）
    const again = { ...env } as NodeJS.ProcessEnv;
    ensureVaultKeyInEnv(dir, again);
    expect(again.MINICLAW_VAULT_KEY).toBe(env.MINICLAW_VAULT_KEY);
  });

  it("无 .env 文件时也能生成密钥（自建 .env）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bootkey-"));
    await rm(join(dir, ".env"), { force: true });
    const env = {} as NodeJS.ProcessEnv;
    ensureVaultKeyInEnv(dir, env);
    expect(env.MINICLAW_VAULT_KEY).toMatch(/^[0-9a-f]{64}$/);
  });
});
