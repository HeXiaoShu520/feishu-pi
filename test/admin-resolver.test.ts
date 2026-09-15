import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistUserProfile, resolveAdminFromLogins, type LoginIdentitySource } from "../src/feishu/admin-resolver.ts";

/** 构造注入版登录态：用户 token / 身份反查全部脚本化（token → 身份直接映射） */
function makeSource(opts: {
  users?: string[];
  tokens?: Record<string, string | undefined>;
  identityByToken?: Record<string, { openId?: string; name?: string; en_name?: string; email?: string }>;
}): LoginIdentitySource & { describeCalls: string[] } {
  const describeCalls: string[] = [];
  return {
    describeCalls,
    listLoginUsers: async () => opts.users ?? [],
    getUserAccessToken: async (openId) => opts.tokens?.[openId],
    describeIdentity: async (token) => {
      describeCalls.push(token);
      return opts.identityByToken?.[token];
    },
  };
}

describe("resolveAdminFromLogins（冷启动管理员识别）", () => {
  it("按姓名匹配已登录用户 → 返回 openId，并把资料写入用户缓存", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adminres-"));
    const usersFile = join(dir, "cli_test_users.json");
    const source = makeSource({
      users: ["ou_a", "ou_boss"],
      tokens: { ou_a: "tok_a", ou_boss: "tok_boss" },
      identityByToken: {
        tok_a: { openId: "ou_a", name: "路人" },
        tok_boss: { openId: "ou_boss", name: "何小书", en_name: "Hexiao" },
      },
    });

    const resolved = await resolveAdminFromLogins(source, "何小书", usersFile);
    expect(resolved).toBe("ou_boss");
    expect(source.describeCalls).toEqual(["tok_a", "tok_boss"]); // 逐个反查，命中即止

    const cache = JSON.parse(await readFile(usersFile, "utf8")) as Record<string, { name?: string; en_name?: string }>;
    expect(cache.ou_boss).toMatchObject({ name: "何小书", en_name: "Hexiao" });
  });

  it("英文名 / openId / 邮箱均可命中", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adminres-"));
    const usersFile = join(dir, "cli_test_users.json");

    expect(await resolveAdminFromLogins(makeSource({
      users: ["ou_x"], tokens: { ou_x: "t" }, identityByToken: { t: { openId: "ou_x", en_name: "John" } },
    }), "John", usersFile)).toBe("ou_x");

    expect(await resolveAdminFromLogins(makeSource({
      users: ["ou_y"], tokens: { ou_y: "t" }, identityByToken: { t: { openId: "ou_y", name: "张三" } },
    }), "ou_y", usersFile)).toBe("ou_y");

    expect(await resolveAdminFromLogins(makeSource({
      users: ["ou_z"], tokens: { ou_z: "t" }, identityByToken: { t: { openId: "ou_z", email: "boss@x.com" } },
    }), "boss@x.com", usersFile)).toBe("ou_z");
  });

  it("无人命中 / token 失效 / 未配置标识 → undefined，不写缓存", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adminres-"));
    const usersFile = join(dir, "cli_test_users.json");

    expect(await resolveAdminFromLogins(makeSource({
      users: ["ou_a"], tokens: { ou_a: "t" }, identityByToken: { t: { openId: "ou_a", name: "路人" } },
    }), "何小书", usersFile)).toBeUndefined();

    expect(await resolveAdminFromLogins(makeSource({
      users: ["ou_a"], tokens: { ou_a: undefined }, identityByToken: { t: { openId: "ou_a", name: "何小书" } },
    }), "何小书", usersFile)).toBeUndefined();

    expect(await resolveAdminFromLogins(makeSource({ users: [] }), "何小书", usersFile)).toBeUndefined();
    expect(await resolveAdminFromLogins(makeSource({}), undefined, usersFile)).toBeUndefined();
    await expect(readFile(usersFile, "utf8")).rejects.toThrow();
  });
});

describe("persistUserProfile（用户缓存合并写入）", () => {
  it("已有条目字段保留合并；目录不存在自动创建", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adminres-"));
    const usersFile = join(dir, "nested", "cli_test_users.json");
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(usersFile, JSON.stringify({ ou_old: { name: "旧名", department_name: ["甲部门"] } }), "utf8");

    await persistUserProfile(join(dir, "other.json"), "ou_new", { name: "新名" });
    await persistUserProfile(usersFile, "ou_old", { en_name: "Old" });

    const cache = JSON.parse(await readFile(usersFile, "utf8")) as Record<string, { name?: string; en_name?: string; department_name?: string[]; updatedAt?: string }>;
    expect(cache.ou_old).toMatchObject({ name: "旧名", en_name: "Old", department_name: ["甲部门"] });
    expect(cache.ou_old.updatedAt).toBeTruthy();
    expect(JSON.parse(await readFile(join(dir, "other.json"), "utf8")).ou_new.name).toBe("新名");
  });
});
