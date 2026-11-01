import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionPolicy } from "../src/permission/policy.ts";

async function writePolicy(content: unknown): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "policy-"));
  const file = join(dir, "permissions.json");
  await writeFile(file, JSON.stringify(content), "utf8");
  return { dir, file };
}

describe("PermissionPolicy：个人策略", () => {
  it("权限配置不含身份分组", async () => {
    const { file } = await writePolicy({ allow: ["Read(docs/**)"] });
    const policy = new PermissionPolicy(file);
    expect((await policy.current()).readAllowed("docs/a.md")).toBe(true);
    expect(await policy.describe()).toMatchObject({ allow: ["Read(docs/**)"], ask: [], deny: [], valid: true });
  });

  it("空策略没有默认放行能力", async () => {
    const { file } = await writePolicy({});
    const current = await new PermissionPolicy(file).current();
    expect(current.readAllowed("README.md")).toBe(false);
    expect(current.toolsAllowed("memory")).toBe(false);
  });

  it("迁移旧配置只读取原 admin 白名单，group 被忽略", async () => {
    const { file } = await writePolicy({ allow: { admin: ["Read(docs/**)"], group: ["Write(**)"] } });
    const current = await new PermissionPolicy(file).current();
    expect(current.readAllowed("docs/a.md")).toBe(true);
    expect(current.writeAllowed("docs/a.md")).toBe(false);
  });

  it("deny 使用和 allow 相同的带类型通配规则，且管理员同样会命中", async () => {
    const { file } = await writePolicy({
      deny: ["Read(**/.env*)", "Write(**/secrets/**)", "Bash(**.env**)", "Tools(admin_*)"],
      allow: { admin: ["Read(**)", "Write(**)", "Bash(*)", "Tools(*)"] },
    });
    const admin = await new PermissionPolicy(file).current();
    expect(admin.readAllowed(".env.local")).toBe(true);
    expect(admin.denied("read", { path: ".env.local" })).toBe("Read(**/.env*)");
    expect(admin.denied("write", { path: "data/secrets/token.txt" })).toBe("Write(**/secrets/**)");
    expect(admin.denied("bash", { command: "cat config/.env.local && git status" })).toBe("Bash(**.env**)");
    expect(admin.denied("admin_reset", {})).toBe("Tools(admin_*)");
    expect(admin.denied("read", { path: "docs/guide.md" })).toBeUndefined();
  });

  it("白名单命令仍保持边界匹配；组合和元字符不会确定性直通", async () => {
    const { file } = await writePolicy({ allow: ["Bash(cat:*)", "Read(docs/**)"] });
    const team = await new PermissionPolicy(file).current();
    expect(team.bashAllowed("cat README.md")).toBe(true);
    expect(team.bashAllowed("catalog secret")).toBe(false);
    expect(team.bashAllowed("cat $SECRET")).toBe(false);
    expect(team.readAllowed("docs/guide.md")).toBe(true);
    expect(team.readAllowed("src/main.ts")).toBe(false);
  });

  it("策略改动会按 mtime 自动重载，损坏策略回退空白名单", async () => {
    const { file } = await writePolicy({ allow: ["Bash(npm run test:*)"] });
    const policy = new PermissionPolicy(file);
    expect((await policy.current()).bashAllowed("npm run build")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeFile(file, JSON.stringify({ allow: ["Bash(npm run build:*)"] }), "utf8");
    expect((await policy.current()).bashAllowed("npm run build --silent")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeFile(file, "broken", "utf8");
    expect((await policy.current()).bashAllowed("npm run build")).toBe(false);
  });
});
