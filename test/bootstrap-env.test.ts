import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureEnvFile } from "../src/bootstrap-env.ts";

describe("ensureEnvFile（.env 缺失自动拷贝）", () => {
  it("无 .env 且有 .env.example → 拷贝一份", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boot-"));
    await writeFile(join(dir, ".env.example"), "FEISHU_APP_ID=\n", "utf8");
    expect(ensureEnvFile(dir)).toBe(true);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("FEISHU_APP_ID=\n");
  });

  it("已有 .env → 不覆盖；无 .env.example → 不动作", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boot-"));
    await writeFile(join(dir, ".env"), "FEISHU_APP_ID=x\n", "utf8");
    expect(ensureEnvFile(dir)).toBe(false);
    expect((await readFile(join(dir, ".env"), "utf8")).includes("FEISHU_APP_ID")).toBe(true);

    const empty = await mkdtemp(join(tmpdir(), "boot-"));
    expect(ensureEnvFile(empty)).toBe(false);
  });
});
