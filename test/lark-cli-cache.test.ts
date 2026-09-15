import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LarkCli } from "../src/feishu/lark-cli.ts";

/** 构造注入版 LarkCli：searchUser 通道脚本化 */
function makeLarkCli(dir: string, searchUser?: (openId: string) => Promise<{ name?: string; en_name?: string; department_name?: string[] } | undefined>) {
  const calls: string[] = [];
  const wrapped = searchUser
    ? async (openId: string) => {
        calls.push(openId);
        return searchUser(openId);
      }
    : undefined;
  const larkCli = new LarkCli("cli_test", dir, { searchUser: wrapped });
  return { larkCli, calls, storeFile: join(dir, "cli_test_users.json") };
}

describe("LarkCli 用户资料查询（lark-cli 搜索单通道）", () => {
  it("搜索命中：姓名+部门入库；3 天内命中缓存不再调用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkcli-"));
    let calls = 0;
    const { larkCli, storeFile } = makeLarkCli(dir, async () => {
      calls += 1;
      return { name: "何裕龙", department_name: ["深圳市卓驭科技有限公司"] };
    });

    const profile = await larkCli.getUserProfile("ou_hyl");
    expect(profile.name).toBe("何裕龙");
    expect(profile.department_name).toEqual(["深圳市卓驭科技有限公司"]);
    expect(calls).toBe(1);

    const raw = JSON.parse(await readFile(storeFile, "utf8"));
    expect(raw.ou_hyl.name).toBe("何裕龙");

    const again = await larkCli.getUserProfile("ou_hyl");
    expect(again.name).toBe("何裕龙");
    expect(calls).toBe(1);
  });

  it("搜索未命中 → 冷却档案落盘（1 天内不重试）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkcli-"));
    let calls = 0;
    const { larkCli } = makeLarkCli(dir, async () => {
      calls += 1;
      return undefined;
    });

    const first = await larkCli.getUserProfile("ou_new");
    expect(first.name).toBe("");
    expect(calls).toBe(1);

    const second = await larkCli.getUserProfile("ou_new");
    expect(second.name).toBe("");
    expect(calls).toBe(1); // 冷却期内不再调用
  });

  it("通道抛错按未命中处理（写冷却档案），不影响调用方", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkcli-"));
    const { larkCli } = makeLarkCli(dir, async () => {
      throw new Error("cli 崩了");
    });
    const profile = await larkCli.getUserProfile("ou_x");
    expect(profile.name).toBe("");
    expect(profile.department_name).toEqual([]);
  });

  it("并发合并：同一用户并发查询共享一次搜索", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkcli-"));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const { larkCli } = makeLarkCli(dir, async () => {
      calls += 1;
      await gate;
      return { name: "并发用户" };
    });

    const p1 = larkCli.getUserProfile("ou_race");
    const p2 = larkCli.getUserProfile("ou_race");
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.name).toBe("并发用户");
    expect(r2.name).toBe("并发用户");
    expect(calls).toBe(1);
  });
});
