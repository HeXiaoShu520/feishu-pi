import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LarkCli } from "../src/feishu/lark-cli.ts";

/** 让 contact.user.get 一直失败的假 Lark Client，并统计调用次数 */
function makeFailingClient(counter: { calls: number }) {
  return {
    contact: {
      user: {
        get: async () => {
          counter.calls += 1;
          throw new Error("API 不可用");
        },
      },
    },
  } as unknown as ConstructorParameters<typeof LarkCli>[0];
}

describe("LarkCli 降级资料入库", () => {
  it("三级查询全部失败时写缓存（仅 openId），到期前不再重新查询", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lark-cli-"));
    const counter = { calls: 0 };
    const larkCli = new LarkCli(makeFailingClient(counter), "cli_test", dir);

    // 无 chatId：API 失败后直接走降级入库
    const profile = await larkCli.getUserProfile("ou_new");
    expect(profile.openId).toBe("ou_new");
    expect(profile.name).toBeUndefined();
    expect(profile.englishName).toBeUndefined();

    // 缓存文件已写入
    const raw = JSON.parse(await readFile(join(dir, "cli_test_users.json"), "utf8"));
    expect(raw.ou_new.openId).toBe("ou_new");
    expect(raw.ou_new.updatedAt).toBeTruthy();

    // 第二次查询命中缓存，不再调用 API
    await larkCli.getUserProfile("ou_new");
    expect(counter.calls).toBe(1);
  });

  it("过期重查失败时保留既有资料，不降级为空", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lark-cli-"));
    const usersFile = join(dir, "cli_test_users.json");
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(usersFile, JSON.stringify({
      ou_known: { openId: "ou_known", name: "张三", englishName: "John", departmentNames: ["技术部"], updatedAt: tenDaysAgo },
    }), "utf8");

    const larkCli = new LarkCli(makeFailingClient({ calls: 0 }), "cli_test", dir);
    const profile = await larkCli.getUserProfile("ou_known");

    // 资料过期触发重查（API 失败），降级入库但保留旧字段
    expect(profile.name).toBe("张三");
    expect(profile.englishName).toBe("John");
    expect(profile.departmentNames).toEqual(["技术部"]);
    // 时间戳已刷新，到期前不会每条消息都重查
    expect(new Date(profile.updatedAt).getTime()).toBeGreaterThan(Date.now() - 60 * 1000);
  });

  it("双 TTL：空档案 1 天即过期重查，有档案 3 天内命中缓存", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lark-cli-"));
    const usersFile = join(dir, "cli_test_users.json");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(usersFile, JSON.stringify({
      ou_sparse: { openId: "ou_sparse", updatedAt: twoDaysAgo },
      ou_rich: { openId: "ou_rich", name: "李四", updatedAt: twoDaysAgo },
    }), "utf8");

    const counter = { calls: 0 };
    const larkCli = new LarkCli(makeFailingClient(counter), "cli_test", dir);

    // 空档案：2 天 > 1 天 TTL → 触发重查（API 调用一次，失败后仍是空档案）
    const sparse = await larkCli.getUserProfile("ou_sparse");
    expect(counter.calls).toBe(1);
    expect(sparse.name).toBeUndefined();

    // 有档案：2 天 < 3 天 TTL → 直接命中缓存，不再调 API
    const rich = await larkCli.getUserProfile("ou_rich");
    expect(counter.calls).toBe(1);
    expect(rich.name).toBe("李四");
  });
});
