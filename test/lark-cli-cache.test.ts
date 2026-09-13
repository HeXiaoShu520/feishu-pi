import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LarkCli } from "../src/feishu/lark-cli.ts";

/** 构造注入版 LarkCli：管理员 token / HTTP GET / 群名单应答全部脚本化 */
function makeLarkCli(opts: {
  dir: string;
  adminToken?: string;
  adminGet: (pathAndQuery: string, token: string) => Promise<Record<string, unknown>>;
  chatMembers?: (payload: unknown) => Promise<unknown>;
}) {
  const chatMembersGet = vi.fn(async (payload: unknown) => {
    if (!opts.chatMembers) throw new Error("不应调用群成员名单");
    return opts.chatMembers(payload);
  });
  const larkCli = new LarkCli(
    { im: { chatMembers: { get: chatMembersGet } } } as unknown as ConstructorParameters<typeof LarkCli>[0],
    "cli_test",
    opts.dir,
    { adminTokenProvider: async () => opts.adminToken, adminGet: opts.adminGet },
  );
  return { larkCli, chatMembersGet, storeFile: join(opts.dir, "cli_test_users.json") };
}

describe("LarkCli 用户资料查询（管理员通道 + 外部用户群名单兜底）", () => {
  it("管理员查询成功：中文名/英文名/部门名入库；3 天内命中缓存", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkcli-"));
    let userCalls = 0;
    const { larkCli } = makeLarkCli({
      dir,
      adminToken: "admin_uat",
      adminGet: async (path) => {
        if (path.includes("/users/")) {
          userCalls += 1;
          return {
            user: {
              name: "外部成员",
              en_name: "Guest",
              department_path: [
                {
                  department_id: "od_dept1",
                  department_name: { name: "平台组" },
                  department_path: { name: "公司/技术部/平台组" },
                },
              ],
            },
          };
        }
        return {};
      },
    });

    const profile = await larkCli.getUserProfile("ou_guest", "oc_group");
    expect(profile.name).toBe("外部成员");
    expect(profile.en_name).toBe("Guest");
    // department_path.name（完整路径）优先于 department_name（直属部门名）
    expect(profile.department_name).toEqual(["公司/技术部/平台组"]);
    expect(userCalls).toBe(1);

    const again = await larkCli.getUserProfile("ou_guest", "oc_group");
    expect(again.name).toBe("外部成员");
    expect(userCalls).toBe(1);
  });

  it("管理员未登录 → 群名单兜底拿中文名并正常入库", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkcli-"));
    let adminGetCalls = 0;
    const { larkCli, storeFile } = makeLarkCli({
      dir,
      adminToken: undefined,
      chatMembers: async () => ({ data: { items: [{ member_id: "ou_new", name: "群名单名字" }] } }),
      adminGet: async () => {
        adminGetCalls += 1;
        return { user: { name: "不该被调用" } };
      },
    });

    const profile = await larkCli.getUserProfile("ou_new", "oc_group");
    expect(profile.name).toBe("群名单名字");
    expect(adminGetCalls).toBe(0); // 无 token 时连管理员 HTTP 都不发

    const raw = JSON.parse(await readFile(storeFile, "utf8"));
    expect(raw.ou_new.name).toBe("群名单名字");
  });

  it("全部通道失败 → 冷却档案落盘（openId + 旧资料），冷却 1 天内不重试", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkcli-"));
    let adminGetCalls = 0;
    let rosterCalls = 0;
    const { larkCli, storeFile } = makeLarkCli({
      dir,
      adminToken: "admin_uat",
      adminGet: async () => {
        adminGetCalls += 1;
        return {}; // 查无此人
      },
      chatMembers: async () => {
        rosterCalls += 1;
        return { data: { items: [{ member_id: "ou_other", name: "别人" }] } };
      },
    });

    // 第一次：全部未命中 → 冷却档案落盘（仅 openId）
    const first = await larkCli.getUserProfile("ou_new", "oc_group");
    expect(first.name).toBe("");
    const raw = JSON.parse(await readFile(storeFile, "utf8"));
    expect(raw.ou_new.name).toBe("");

    // 冷却期内（<1 天）：直接命中缓存，不再打接口
    const second = await larkCli.getUserProfile("ou_new", "oc_group");
    expect(second.name).toBe("");
    expect(adminGetCalls).toBe(1);
    expect(rosterCalls).toBe(1);
  });

  it("失败进入冷却时保留旧资料；冷却期满重查成功后刷新入库", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkcli-"));
    const storeFile = join(dir, "cli_test_users.json");
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(storeFile, JSON.stringify({
      ou_known: { openId: "ou_known", name: "张三", en_name: "John", department_name: ["技术部"], updatedAt: tenDaysAgo },
    }), "utf8");

    let fail = true;
    const larkCli = new LarkCli(
      { im: { chatMembers: { get: async () => ({ data: { items: [] } }) } } } as unknown as ConstructorParameters<typeof LarkCli>[0],
      "cli_test",
      dir,
      {
        adminTokenProvider: async () => "admin_uat",
        adminGet: async (path: string) => {
          if (fail) throw new Error("接口异常");
          if (path.includes("/users/")) {
            return {
              user: {
                name: "张三",
                en_name: "John",
                department_path: [{ department_name: { name: "技术部" }, department_path: { name: "公司/技术部" } }],
              },
            };
          }
          return {};
        },
      },
    );

    // 过期重查失败：保留旧资料，进入冷却（时间戳刷新）
    const kept = await larkCli.getUserProfile("ou_known", "oc_group");
    expect(kept.name).toBe("张三");
    expect(kept.en_name).toBe("John");
    const raw1 = JSON.parse(await readFile(storeFile, "utf8"));
    expect(raw1.ou_known.updatedAt).not.toBe(tenDaysAgo);
    expect(raw1.ou_known.name).toBe("张三");

    // 模拟冷却期满（磁盘档案时间戳拨回 10 天前，新实例重新加载磁盘）+ 接口恢复 → 重查成功刷新
    const aged = JSON.parse(await readFile(storeFile, "utf8"));
    aged.ou_known.updatedAt = tenDaysAgo;
    await writeFile(storeFile, JSON.stringify(aged, null, 2), "utf8");
    fail = false;
    const larkCli2 = new LarkCli(
      { im: { chatMembers: { get: async () => ({ data: { items: [] } }) } } } as unknown as ConstructorParameters<typeof LarkCli>[0],
      "cli_test",
      dir,
      {
        adminTokenProvider: async () => "admin_uat",
        adminGet: async (path: string) => {
          if (path.includes("/users/")) {
            return {
              user: {
                name: "张三",
                en_name: "John",
                department_path: [{ department_name: { name: "技术部" }, department_path: { name: "公司/技术部" } }],
              },
            };
          }
          return {};
        },
      },
    );
    const refreshed = await larkCli2.getUserProfile("ou_known", "oc_group");
    expect(refreshed.en_name).toBe("John");
    expect(refreshed.department_name).toEqual(["公司/技术部"]);
  });
});
