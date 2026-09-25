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

describe("PermissionPolicy：管理员 + 非管理员团队", () => {
  it("管理员只由 FEISHU_PI_ADMIN 解析后的 open_id 识别；其余用户自动属于 group", async () => {
    const { file } = await writePolicy({ allow: { admin: [], group: [] } });
    const policy = new PermissionPolicy(file, { adminId: "ou_admin" });

    expect(await policy.groupsFor("ou_admin")).toEqual(["admin"]);
    expect(await policy.groupsFor("ou_team")).toEqual(["group"]);
    expect(await policy.groupsFor("ou_guest", "访客")).toEqual(["group"]);
  });

  it("管理员未配置时，所有用户都属于 group", async () => {
    const { file } = await writePolicy({ allow: { group: [] } });
    const policy = new PermissionPolicy(file);
    expect(await policy.groupsFor("ou_first")).toEqual(["group"]);
    expect(await policy.groupsFor("ou_second")).toEqual(["group"]);
  });

  it("只有 admin / group 配置会生效；common 和第二团队被忽略", async () => {
    const { file } = await writePolicy({
      allow: {
        common: ["Read(common/**)"],
        group_2: ["Read(second/**)"],
        group: ["Read(docs/**)", "Tools(memory)"],
        admin: ["Bash(git status:*)", "Write(.agent/**)"],
      },
    });
    const policy = new PermissionPolicy(file);
    const guest = await policy.forGroups([]);
    const team = await policy.forGroups(["group", "group_2"]);
    const admin = await policy.forGroups(["admin"]);
    expect(guest.groups).toEqual([]);
    expect(guest.isTeam).toBe(false);
    expect(guest.readAllowed("common/a.md")).toBe(false);
    expect(team.readAllowed("docs/a.md")).toBe(true);
    expect(team.readAllowed("second/a.md")).toBe(false);
    expect(team.toolsAllowed("memory")).toBe(true);
    expect(admin.bashAllowed("git status --short")).toBe(true);
    expect(admin.writeAllowed(".agent/SYSTEM.md")).toBe(true);
  });

  it("deny 使用和 allow 相同的带类型通配规则，且管理员同样会命中", async () => {
    const { file } = await writePolicy({
      deny: ["Read(**/.env*)", "Write(**/secrets/**)", "Bash(**.env**)", "Tools(admin_*)"],
      allow: { admin: ["Read(**)", "Write(**)", "Bash(*)", "Tools(*)"] },
    });
    const admin = await new PermissionPolicy(file).forGroups(["admin"]);
    expect(admin.readAllowed(".env.local")).toBe(true);
    expect(admin.denied("read", { path: ".env.local" })).toBe("Read(**/.env*)");
    expect(admin.denied("write", { path: "data/secrets/token.txt" })).toBe("Write(**/secrets/**)");
    expect(admin.denied("bash", { command: "cat config/.env.local && git status" })).toBe("Bash(**.env**)");
    expect(admin.denied("admin_reset", {})).toBe("Tools(admin_*)");
    expect(admin.denied("read", { path: "docs/guide.md" })).toBeUndefined();
  });

  it("白名单命令仍保持边界匹配；组合和元字符不会确定性直通", async () => {
    const { file } = await writePolicy({ allow: { group: ["Bash(cat:*)", "Read(docs/**)"] } });
    const team = await new PermissionPolicy(file).forGroups(["group"]);
    expect(team.bashAllowed("cat README.md")).toBe(true);
    expect(team.bashAllowed("catalog secret")).toBe(false);
    expect(team.bashAllowed("cat $SECRET")).toBe(false);
    expect(team.readAllowed("docs/guide.md")).toBe(true);
    expect(team.readAllowed("src/main.ts")).toBe(false);
  });

  it("策略改动会按 mtime 自动重载，损坏策略回退空白名单", async () => {
    const { file } = await writePolicy({ allow: { group: ["Bash(npm run test:*)"] } });
    const policy = new PermissionPolicy(file);
    expect((await policy.forGroups(["group"])).bashAllowed("npm run build")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeFile(file, JSON.stringify({ allow: { group: ["Bash(npm run build:*)"] } }), "utf8");
    expect((await policy.forGroups(["group"])).bashAllowed("npm run build --silent")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeFile(file, "broken", "utf8");
    expect((await policy.forGroups(["group"])).bashAllowed("npm run build")).toBe(false);
  });
});
