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

describe("PermissionPolicy 多组统一策略", () => {
  it("组判定：FEISHU_ADMIN → admin；其余按 groupMembership（英文名经用户缓存解析）匹配", async () => {
    const { dir, file } = await writePolicy({
      admin: { bash: ["*"], read: ["**"], write: ["**"], tools: ["*"] },
      group1: { bash: ["npm run test:*"], read: ["docs/**", ".agent/skills/**"], tools: ["query_skill_usage"] },
      group2: { read: [".agent/skills/**"] },
    });
    const usersFile = join(dir, "users.json");
    await writeFile(usersFile, JSON.stringify({ ou_x: { openId: "ou_x", englishName: "John" } }), "utf8");

    const policy = new PermissionPolicy(file, {
      adminId: "ou_admin",
      groupMembership: { admin: ["John"], group1: ["李雷"], group2: ["韩梅梅"] },
      usersFile,
    });
    expect(await policy.groupsFor("ou_admin")).toEqual(["admin"]);
    // ou_x 不在名单，但其英文名 John（经用户缓存解析）命中 admin
    expect(await policy.groupsFor("ou_x", "张三")).toContain("admin");
    expect(await policy.groupsFor("ou_lilei", "李雷")).toContain("group1");
    expect(await policy.groupsFor("ou_mm", "韩梅梅")).toContain("group2");
  });

  it("生效范围 = 所属各组（并集）；组间互不影响", async () => {
    const { file } = await writePolicy({
      group1: { bash: ["npm run test:*"], read: ["docs/**", ".agent/skills/**"], tools: ["*"] },
      group2: {},
    });
    const policy = new PermissionPolicy(file, { groupMembership: { group1: ["李雷"], group2: ["小明"] } });

    const g1 = await policy.forGroups(["group1"]);
    expect(g1.bashAllowed("npm run test -- --watch")).toBe(true);
    expect(g1.bashAllowed("npm run build")).toBe(false);
    expect(g1.readAllowed("docs/guide.md")).toBe(true);
    expect(g1.readAllowed(".agent/skills/hello.md")).toBe(true);
    expect(g1.readAllowed("src/main.ts")).toBe(false);
    expect(g1.toolsAllowed("query_skill_usage")).toBe(true);
    expect(g1.toolsAllowed("schedule_manager")).toBe(true);  // tools: ["*"]
  });

  it("一人多组：能力取并集", async () => {
    const { file } = await writePolicy({
      group2: { bash: ["npm run check:*"] },
    });
    const policy = new PermissionPolicy(file, { groupMembership: { group1: ["李雷"], group2: ["李雷"] } });
    const groups = await policy.groupsFor("李雷", "李雷");
    expect(groups).toEqual(expect.arrayContaining(["group1", "group2"]));

    const both = await policy.forGroups(groups);
    expect(both.bashAllowed("npm run check --silent")).toBe(true);
  });

  it("无组 → 保守缺省：仅技能目录可读，无命令，无工具", async () => {
    const { file } = await writePolicy({ group1: { bash: ["npm run test:*"] } });
    const policy = new PermissionPolicy(file, { groupMembership: { group1: ["李雷"] } });
    const p = await policy.forGroups([]);   // 不在任何组
    expect(p.bashAllowed("npm run test")).toBe(false);
    expect(p.readAllowed(".agent/skills/x.md")).toBe(true);
    expect(p.readAllowed("src/main.ts")).toBe(false);
    expect(p.toolsAllowed("anything")).toBe(false);
    expect(p.isAdmin).toBe(false);
  });

  it("admin 缺省全量：未配置 bash 时所有命令放行，所有工具可用", async () => {
    const { file } = await writePolicy({ admin: {} });
    const policy = new PermissionPolicy(file, { groupMembership: { admin: ["张三"] } });
    const admin = await policy.forGroups(["admin"]);
    expect(admin.isAdmin).toBe(true);
    expect(admin.bashAllowed("任意命令")).toBe(true);
    expect(admin.readAllowed("/etc/hosts")).toBe(true);
    expect(admin.toolsAllowed("任意工具")).toBe(true);
  });

  it("策略文件缺失：无人是 admin，user 保守缺省", async () => {
    const dir = await mkdtemp(join(tmpdir(), "policy-"));
    const policy = new PermissionPolicy(join(dir, "missing.json"), { adminId: "ou_a" });
    expect(await policy.groupsFor("ou_a")).toEqual(["admin"]);
    const p = await policy.forGroups([]);
    expect(p.readAllowed(".agent/skills/x.md")).toBe(true);
    expect(p.readAllowed("src/main.ts")).toBe(false);
  });

  it("策略文件修改后自动重载（mtime）", async () => {
    const { file } = await writePolicy({ group1: { bash: ["npm run test:*"] } });
    const policy = new PermissionPolicy(file, { groupMembership: { group1: ["李雷"] } });
    expect((await policy.forGroups(["group1"])).bashAllowed("npm run build")).toBe(false);

    await new Promise((r) => setTimeout(r, 25));
    await writeFile(file, JSON.stringify({ group1: { bash: ["npm run test:*", "npm run build:*"] } }), "utf8");
    expect((await policy.forGroups(["group1"])).bashAllowed("npm run build --prod")).toBe(true);
  });

  it("describe 返回各组生效范围", async () => {
    const { file } = await writePolicy({
      admin: { read: ["**"], tools: ["*"] },
      group1: { read: ["docs/**", ".agent/skills/**"], tools: ["query_skill_usage"] },
    });
    const policy = new PermissionPolicy(file, { groupMembership: { admin: ["张三"], group1: ["李雷"] } });
    const d = await policy.describe();
    expect(d.groups.admin.effective.read).toContain("**");
    expect(d.groups.admin.effective.tools).toEqual(expect.arrayContaining(["*"]));
    // group1 生效 read = 自身配置
    expect(d.groups.group1.effective.read).toEqual(expect.arrayContaining(["docs/**", ".agent/skills/**"]));
    expect(d.groups.group1.effective.tools).toEqual(["query_skill_usage"]);
  });
});

  it("common 默认层：所有人自动叠加，组在其上追加；admin 并集不受影响", async () => {
    const { file } = await writePolicy({
      common: ["Read(.agent/skills/**)", "Tools(query_skill_usage)"],
      admin: { bash: ["*"], read: ["**"], write: ["**"], tools: ["*"] },
      group1: { read: ["docs/**"] },
    });
    const policy = new PermissionPolicy(file, { groupMembership: { group1: ["李雷"] } });

    // 无组用户：只有 common（读技能目录 + 指定工具）
    const none = await policy.forGroups([]);
    expect(none.readAllowed(".agent/skills/x.md")).toBe(true);
    expect(none.toolsAllowed("query_skill_usage")).toBe(true);
    expect(none.readAllowed("docs/guide.md")).toBe(false);
    expect(none.bashAllowed("npm run test")).toBe(false);

    // group1：common ∪ 自身（docs 可读来自自身规则）
    const g1 = await policy.forGroups(["group1"]);
    expect(g1.readAllowed(".agent/skills/x.md")).toBe(true);
    expect(g1.readAllowed("docs/guide.md")).toBe(true);
    expect(g1.toolsAllowed("query_skill_usage")).toBe(true);

    // admin：common ∪ admin 缺省全量，能力不变
    const admin = await policy.forGroups(["admin"]);
    expect(admin.readAllowed("src/main.ts")).toBe(true);
    expect(admin.toolsAllowed("任意工具")).toBe(true);

    // describe 中包含 common 条目
    const d = await policy.describe();
    expect(d.groups.common.effective.read).toContain(".agent/skills/**");
  });
