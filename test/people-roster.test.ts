import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeopleRoster } from "../src/feishu/people-roster.ts";

const ROSTER = {
  ou_zhang: { name: "张三", en_name: "Zhang San", department_name: ["研发部-平台组"] },
  ou_john: { name: "约翰", en_name: "John", department_name: [] },
  ou_wang: { name: "王五", en_name: "" },
  ou_boss: { name: "李大老板", en_name: "Boss" },
};

async function makeRoster(content: unknown): Promise<PeopleRoster> {
  const dir = await mkdtemp(join(tmpdir(), "roster-"));
  const file = join(dir, "cli_test_users.json");
  await writeFile(file, JSON.stringify(content), "utf8");
  return new PeopleRoster(file);
}

describe("PeopleRoster（预制人员名单）", () => {
  it("中文名子串命中 → 提示段含 open_id / 部门 / at 用法；按文中出现位置排序", async () => {
    const roster = await makeRoster(ROSTER);
    const hint = await roster.buildHint("让张三 review 一下，再叫王五跟进", "ou_me");
    expect(hint).toBeTruthy();
    expect(hint).toContain("ou_zhang");
    expect(hint).toContain("研发部-平台组");
    expect(hint).toContain("ou_wang");
    // 张三在前（文中先出现）
    expect(hint!.indexOf("ou_zhang")).toBeLessThan(hint!.indexOf("ou_wang"));
    expect(hint).toContain("<at id=");
  });

  it("英文名按词边界不区分大小写命中；单词内部不误命中", async () => {
    const roster = await makeRoster(ROSTER);
    expect((await roster.match("叫 john 看看")).map((h) => h.openId)).toEqual(["ou_john"]);
    expect((await roster.match("JOHN 在吗")).map((h) => h.openId)).toEqual(["ou_john"]);
    // Johnson 包含 John 但不是独立词 → 不命中
    expect(await roster.match("找 Johnson 确认")).toEqual([]);
  });

  it("at 标签里的展示名不重复命中；发送者本人不提示；单字名不参与", async () => {
    const roster = await makeRoster({ ou_w: { name: "王", en_name: "Wang" }, ...ROSTER });
    // 被 @ 的人（约翰/John 在标签里）不再按名字命中
    const atMention = await roster.match('<at user_id="ou_john">约翰 John</at> 帮忙看看');
    expect(atMention).toEqual([]);

    // 发送者本人：张三自己提到自己 → 不提示
    const self = await roster.match("我张三认为可行", { senderOpenId: "ou_zhang" });
    expect(self.map((x) => x.openId)).toEqual([]);

    // 单字名"王"不参与匹配
    expect(await roster.match("王说得对", { senderOpenId: "ou_me" })).toEqual([]);
  });

  it("同字多人：两个同名的人都提示（模型自行消歧）；limit 截断", async () => {
    const roster = await makeRoster({ ...ROSTER, ou_zhang2: { name: "张三", en_name: "Zhang San 2" } });
    const hits = await roster.match("张三来一下", { senderOpenId: "ou_me" });
    expect(hits.map((h) => h.openId).sort()).toEqual(["ou_zhang", "ou_zhang2"]);

    const capped = await makeRoster({
      a1: { name: "甲一" }, a2: { name: "甲二" }, a3: { name: "甲三" },
    });
    expect((await capped.match("甲一 甲二 甲三", { senderOpenId: "ou_me", limit: 2 })).length).toBe(2);
  });

  it("名单文件缺失/损坏/无名字条目 → 不报错、无提示；文件更新后 mtime 重载", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roster-"));
    const file = join(dir, "cli_test_users.json");
    const roster = new PeopleRoster(file);
    expect(await roster.buildHint("张三", "ou_me")).toBeUndefined();

    await writeFile(file, "{broken", "utf8");
    expect(await roster.buildHint("张三", "ou_me")).toBeUndefined();

    await writeFile(file, JSON.stringify(ROSTER), "utf8");
    await utimes(file, new Date(), new Date(Date.now() + 1000));
    expect((await roster.match("张三", { senderOpenId: "ou_me" })).map((h) => h.openId)).toEqual(["ou_zhang"]);
  });

  it("buildHint 无命中返回 undefined；命中时声明不要复述提示段", async () => {
    const roster = await makeRoster(ROSTER);
    expect(await roster.buildHint("今天天气不错", "ou_me")).toBeUndefined();
    const hint = await roster.buildHint("张三在吗", "ou_me");
    expect(hint).toContain("不要复述");
  });
});

describe("mentionedUserIds（@ 提及入库的提取）", () => {
  it("剔除无 openId/机器人/发送者本人；按出现顺序去重", async () => {
    const { mentionedUserIds } = await import("../src/feishu/people-roster.ts");
    const mentions = [
      { openId: "ou_all" },                                   // @所有人：无 openId？此处有——不应剔除
      { openId: undefined, name: "所有人" },                   // 无 openId → 剔除
      { openId: "ou_bot", isBot: true },                      // 机器人 → 剔除
      { openId: "ou_me" },                                    // 发送者本人 → 剔除
      { openId: "ou_a", name: "张三" },
      { openId: "ou_a", name: "张三" },                        // 重复 → 去重
      { openId: "ou_b", name: "李四" },
    ];
    expect(mentionedUserIds(mentions, "ou_me")).toEqual(["ou_all", "ou_a", "ou_b"]);
    expect(mentionedUserIds([], "ou_me")).toEqual([]);
  });
});
