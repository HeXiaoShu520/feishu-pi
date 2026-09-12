import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LarkCli } from "../src/feishu/lark-cli.ts";

/** 构造注入版 LarkCli：管理员 token 与 HTTP GET 全部可脚本化，时钟由测试推进 */
function makeLarkCli(opts: {
  storeFile: string;
  adminToken?: string | undefined;
  adminGet: (pathAndQuery: string, token: string) => Promise<Record<string, unknown>>;
}) {
  const larkCli = new LarkCli("cli_test", opts.storeFile, {
    adminTokenProvider: async () => opts.adminToken,
    adminGet: opts.adminGet,
  });
  return { larkCli };
}

function seedProfile(storeFile: string, openId: string, profile: Record<string, unknown>): Promise<void> {
  return writeFile(storeFile, JSON.stringify({ [openId]: profile }), "utf8");
}

describe("LarkCli 管理员身份用户资料查询", () => {
  it("查询成功：中文名/英文名/部门名入库并缓存；二次查询不再发请求", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkcli-"));
    const storeFile = join(dir, "cli_test_users.json");
    let userCalls = 0;
    const { larkCli } = makeLarkCli({
      storeFile,
      adminToken: "admin_uat",
      adminGet: async (path) => {
        if (path.includes("/users/")) {
          userCalls += 1;
          return { user: { name: "外部成员", en_name: "Guest", department_ids: ["od_dept1"] } };
        }
        return { items: [{ department_id: "od_dept1", name: "技术部" }] };
      },
    });

    const profile = await larkCli.getUserProfile("ou_guest");
    expect(profile.name).toBe("外部成员");
    expect(profile.englishName).toBe("Guest");
    expect(profile.departmentNames).toEqual(["技术部"]);
    expect(userCalls).toBe(1);

    // 缓存命中：3 天内不再发请求
    const again = await larkCli.getUserProfile("ou_guest");
    expect(again.name).toBe("外部成员");
    expect(userCalls).toBe(1);
  });

  it("管理员未登录（token 缺失）→ 最小档案不落盘，下一条消息重试", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkcli-"));
    const storeFile = join(dir, "cli_test_users.json");
    let adminGetCalls = 0;
    const { larkCli } = makeLarkCli({
      storeFile,
      adminToken: undefined,
      adminGet: async () => {
        adminGetCalls += 1;
        return { user: { name: "不该被调用" } };
      },
    });

    const profile = await larkCli.getUserProfile("ou_new");
    expect(profile.openId).toBe("ou_new");
    expect(profile.name).toBeUndefined();
    await expect(readFile(storeFile, "utf8")).rejects.toThrow(); // 失败不落盘

    // 下一条消息会再尝试（虽然仍拿不到 token）
    const again = await larkCli.getUserProfile("ou_new");
    expect(again.openId).toBe("ou_new");
    expect(adminGetCalls).toBe(0); // 无 token 时连 HTTP 都不发
  });

  it("查询失败保留旧资料且不改缓存文件；过期重查成功后更新", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkcli-"));
    const storeFile = join(dir, "cli_test_users.json");
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await seedProfile(storeFile, "ou_known", {
      openId: "ou_known", name: "张三", englishName: "John", departmentNames: ["技术部"], updatedAt: tenDaysAgo,
    });

    let fail = true;
    const larkCli = new LarkCli("cli_test", dir, {
      adminTokenProvider: async () => "admin_uat",
      adminGet: async (path) => {
        if (fail) throw new Error("接口异常");
        if (path.includes("/users/")) {
          return { user: { name: "张三", en_name: "John", department_ids: ["od_dept1"] } };
        }
        return { items: [{ department_id: "od_dept1", name: "技术部" }] };
      },
    });

    // 过期重查失败：返回旧资料，缓存文件原样（旧时间戳），下次继续重试
    const kept = await larkCli.getUserProfile("ou_known");
    expect(kept.name).toBe("张三");
    const raw1 = JSON.parse(await readFile(storeFile, "utf8"));
    expect(raw1.ou_known.updatedAt).toBe(tenDaysAgo);

    // 恢复后重查成功：资料刷新入库
    fail = false;
    const refreshed = await larkCli.getUserProfile("ou_known");
    expect(refreshed.englishName).toBe("John");
    expect(refreshed.departmentNames).toEqual(["技术部"]);
    const raw2 = JSON.parse(await readFile(storeFile, "utf8"));
    expect(raw2.ou_known.updatedAt).not.toBe(tenDaysAgo);
  });
});
