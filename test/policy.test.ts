import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionPolicy } from "../src/permission/policy.ts";

/** 写一份策略文件（新结构：顶层只有 deny + allow 两个输入） */
async function writePolicy(content: unknown): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "policy-"));
  const file = join(dir, "permissions.json");
  await writeFile(file, JSON.stringify(content), "utf8");
  return { dir, file };
}

describe("PermissionPolicy deny + allow 两输入", () => {
  it("组判定：FEISHU_ADMIN → admin；其余按 groupMembership（英文名经用户缓存解析）匹配", async () => {
    const { dir, file } = await writePolicy({
      allow: {
        admin: ["Bash(*)", "Read(**)", "Write(**)", "Tools(*)"],
        group_1: ["Bash(npm run test:*)", "Read(docs/**)", "Read(.agent/skills/**)", "Tools(query_skill_usage)"],
        group_2: ["Read(.agent/skills/**)"],
      },
    });
    const usersFile = join(dir, "users.json");
    await writeFile(usersFile, JSON.stringify({ ou_x: { openId: "ou_x", en_name: "John" } }), "utf8");

    const policy = new PermissionPolicy(file, {
      adminId: "ou_admin",
      groupMembership: { admin: ["John"], group_1: ["李雷"], group_2: ["韩梅梅"] },
      usersFile,
    });
    expect(await policy.groupsFor("ou_admin")).toEqual(["admin"]);
    // ou_x 不在名单，但其英文名 John（经用户缓存解析）命中 admin
    expect(await policy.groupsFor("ou_x", "张三")).toContain("admin");
    expect(await policy.groupsFor("ou_lilei", "李雷")).toContain("group_1");
    expect(await policy.groupsFor("ou_mm", "韩梅梅")).toContain("group_2");
  });

  it("生效范围 = 所属各组（并集）；组间互不影响", async () => {
    const { file } = await writePolicy({
      allow: {
        group_1: ["Bash(npm run test:*)", "Read(docs/**)", "Read(.agent/skills/**)", "Tools(*)"],
        group_2: [],
      },
    });
    const policy = new PermissionPolicy(file, { groupMembership: { group_1: ["李雷"], group_2: ["小明"] } });

    const g1 = await policy.forGroups(["group_1"]);
    expect(g1.bashAllowed("npm run test -- --watch")).toBe(true);
    expect(g1.bashAllowed("npm run build")).toBe(false);
    expect(g1.readAllowed("docs/guide.md")).toBe(true);
    expect(g1.readAllowed(".agent/skills/hello.md")).toBe(true);
    expect(g1.readAllowed("src/main.ts")).toBe(false);
    expect(g1.toolsAllowed("query_skill_usage")).toBe(true);
    expect(g1.toolsAllowed("schedule_manager")).toBe(true);  // Tools(*)
  });

  it("一人多组：能力取并集", async () => {
    const { file } = await writePolicy({
      allow: { group_2: ["Bash(npm run check:*)"] },
    });
    const policy = new PermissionPolicy(file, { groupMembership: { group_1: ["李雷"], group_2: ["李雷"] } });
    const groups = await policy.groupsFor("李雷", "李雷");
    expect(groups).toEqual(expect.arrayContaining(["group_1", "group_2"]));

    const both = await policy.forGroups(groups);
    expect(both.bashAllowed("npm run check --silent")).toBe(true);
  });

  it("无组 → 保守缺省：仅技能目录可读，无命令，无工具", async () => {
    const { file } = await writePolicy({
      allow: { group_1: ["Bash(npm run test:*)"] },
    });
    const policy = new PermissionPolicy(file, { groupMembership: { group_1: ["李雷"] } });
    const p = await policy.forGroups([]);   // 不在任何组
    expect(p.bashAllowed("npm run test")).toBe(false);
    expect(p.readAllowed(".agent/skills/x.md")).toBe(true);
    expect(p.readAllowed("src/main.ts")).toBe(false);
    expect(p.toolsAllowed("anything")).toBe(false);
    expect(p.isAdmin).toBe(false);
  });

  it("admin 缺省全量：未配置 bash 时所有命令放行，所有工具可用", async () => {
    const { file } = await writePolicy({ allow: { admin: [] } });
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
    const { file } = await writePolicy({
      allow: { group_1: ["Bash(npm run test:*)"] },
    });
    const policy = new PermissionPolicy(file, { groupMembership: { group_1: ["李雷"] } });
    expect((await policy.forGroups(["group_1"])).bashAllowed("npm run build")).toBe(false);

    await new Promise((r) => setTimeout(r, 25));
    await writeFile(file, JSON.stringify({ allow: { group_1: ["Bash(npm run test:*)", "Bash(npm run build:*)"] } }), "utf8");
    expect((await policy.forGroups(["group_1"])).bashAllowed("npm run build --prod")).toBe(true);
  });

  it("describe 返回各组生效范围 + deny 全集", async () => {
    const { file } = await writePolicy({
      deny: ["**/vault/**"],
      allow: {
        admin: ["Read(**)", "Tools(*)"],
        group_1: ["Read(docs/**)", "Read(.agent/skills/**)", "Tools(query_skill_usage)"],
      },
    });
    const policy = new PermissionPolicy(file, { groupMembership: { admin: ["张三"], group_1: ["李雷"] } });
    const d = await policy.describe();
    expect(d.groups.admin.effective.read).toContain("**");
    expect(d.groups.admin.effective.tools).toEqual(expect.arrayContaining(["*"]));
    // group_1 生效 read = 自身配置
    expect(d.groups.group_1.effective.read).toEqual(expect.arrayContaining(["docs/**", ".agent/skills/**"]));
    expect(d.groups.group_1.effective.tools).toEqual(["query_skill_usage"]);
    // deny 全集 = 完全来自 permissions.json
    expect(d.deny).toEqual(["**/vault/**"]);
  });

  it("common 默认层：所有人自动叠加，组在其上追加；admin 并集不受影响", async () => {
    const { file } = await writePolicy({
      allow: {
        common: ["Read(.agent/skills/**)", "Tools(query_skill_usage)"],
        admin: ["Bash(*)", "Read(**)", "Write(**)", "Tools(*)"],
        group_1: ["Read(docs/**)"],
      },
    });
    const policy = new PermissionPolicy(file, { groupMembership: { group_1: ["李雷"] } });

    // 无组用户：只有 common（读技能目录 + 指定工具）
    const none = await policy.forGroups([]);
    expect(none.readAllowed(".agent/skills/x.md")).toBe(true);
    expect(none.toolsAllowed("query_skill_usage")).toBe(true);
    expect(none.readAllowed("docs/guide.md")).toBe(false);
    expect(none.bashAllowed("npm run test")).toBe(false);

    // group_1：common ∪ 自身（docs 可读来自自身规则）
    const g1 = await policy.forGroups(["group_1"]);
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

  it("deny 第 0 层：显式模式对所有人（含 admin）生效，先于 allow 判定", async () => {
    const { file } = await writePolicy({
      deny: ["**/.env", ".env.*", "*.key", "**/vault/**"],
      allow: { admin: ["Bash(*)", "Read(**)", "Write(**)", "Tools(*)"] },
    });
    const policy = new PermissionPolicy(file, { groupMembership: { admin: ["张三"] } });
    const admin = await policy.forGroups(["admin"]);

    // allow 规则全放行，但 deny 清单命中即拦
    expect(admin.readAllowed(".env")).toBe(true);
    expect(admin.deniedPath(".env")).toBe("**/.env");
    expect(admin.deniedPath("config/.env.local")).toBe(".env.*");
    expect(admin.deniedPath("certs/server.key")).toBe("*.key");
    // 自定义追加模式生效
    expect(admin.deniedPath("data/vault/k.txt")).toBe("**/vault/**");
    // 例外：.env.example 是无密钥模板，不拦
    expect(admin.deniedPath(".env.example")).toBeUndefined();
    expect(admin.deniedPath("config/prod.env.example")).toBeUndefined();
    // 正常路径不误伤
    expect(admin.deniedPath("docs/guide.md")).toBeUndefined();
  });
});

describe("组成员按组织架构部门名匹配", () => {
  it("用户缓存部门路径包含配置的部门名 → 视为组成员", async () => {
    const { dir, file } = await writePolicy({
      allow: { group_1: ["Bash(npm run test:*)", "Read(.agent/skills/**)"] },
    });
    const usersFile = join(dir, "users.json");
    await writeFile(usersFile, JSON.stringify({
      ou_in: { name: "张内部", department_name: ["自动驾驶研发部-系统工程交付部-基础功能部"] },
      ou_out: { name: "李外部", department_name: ["销售部"] },
      ou_none: { name: "王无部门" },
    }), "utf8");

    const policy = new PermissionPolicy(file, {
      groupMembership: { group_1: ["系统工程交付部"] },
      usersFile,
    });
    expect(await policy.groupsFor("ou_in")).toContain("group_1");
    expect(await policy.groupsFor("ou_out")).not.toContain("group_1");
    expect(await policy.groupsFor("ou_none")).not.toContain("group_1");
  });

  it("open_id 形式的成员项不做部门名包含匹配（避免误命中）", async () => {
    const { dir, file } = await writePolicy({ allow: { group_1: [] } });
    const usersFile = join(dir, "users.json");
    await writeFile(usersFile, JSON.stringify({
      ou_x: { department_name: ["ou_member_as_dept-子系统"] },
    }), "utf8");
    const policy = new PermissionPolicy(file, {
      groupMembership: { group_1: ["ou_member_as_dept"] },
      usersFile,
    });
    // ou_x 的部门路径包含字符串 ou_member_as_dept，但成员项以 ou_ 开头 → 只按 openId 精确匹配
    expect(await policy.groupsFor("ou_x")).not.toContain("group_1");
  });
});
