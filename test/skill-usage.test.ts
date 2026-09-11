import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchSkillRead, SkillUsageStore } from "../src/stats/skill-usage-store.ts";

const CWD = "/proj";
const AGENT_DIR = "/proj/.agent";

describe("matchSkillRead", () => {
  it("识别内置 read（path 参数）读取项目技能文件", () => {
    expect(matchSkillRead("read", { path: ".agent/skills/code-review.md" }, CWD, AGENT_DIR)).toBe("code-review");
  });

  it("识别受限 read（file_path 参数）读取技能文件", () => {
    expect(matchSkillRead("read", { file_path: ".agent/skills/hello.md" }, CWD, AGENT_DIR)).toBe("hello");
  });

  it("识别绝对路径", () => {
    expect(matchSkillRead("read", { path: "/proj/.agent/skills/deploy.md" }, CWD, AGENT_DIR)).toBe("deploy");
  });

  it("非技能路径返回 null", () => {
    expect(matchSkillRead("read", { path: "src/main.ts" }, CWD, AGENT_DIR)).toBeNull();
    expect(matchSkillRead("read", { path: ".env" }, CWD, AGENT_DIR)).toBeNull();
  });

  it("技能目录下的非 .md 文件返回 null", () => {
    expect(matchSkillRead("read", { path: ".agent/skills/README.txt" }, CWD, AGENT_DIR)).toBeNull();
  });

  it("目录穿越不误判为技能读取", () => {
    expect(matchSkillRead("read", { path: ".agent/skills/../../.env" }, CWD, AGENT_DIR)).toBeNull();
  });

  it("非 read 工具返回 null", () => {
    expect(matchSkillRead("bash", { command: "cat .agent/skills/hello.md" }, CWD, AGENT_DIR)).toBeNull();
  });

  it("缺少路径参数返回 null", () => {
    expect(matchSkillRead("read", {}, CWD, AGENT_DIR)).toBeNull();
    expect(matchSkillRead("read", undefined, CWD, AGENT_DIR)).toBeNull();
  });
});

describe("SkillUsageStore", () => {
  it("记录事件并读回；新实例从文件恢复（跨重启）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-usage-"));
    const file = join(dir, "skill-usage.jsonl");

    const store = new SkillUsageStore(file);
    await store.record({ ts: 1000, user: "ou_a", skill: "hello" });
    await store.record({ ts: 2000, user: "ou_b", skill: "code-review", chatId: "oc_x" });
    expect((await store.list()).length).toBe(2);

    const reloaded = new SkillUsageStore(file);
    const events = await reloaded.list();
    expect(events.length).toBe(2);
    expect(events[1]).toEqual({ ts: 2000, user: "ou_b", skill: "code-review", chatId: "oc_x" });
  });

  it("展示名解析：英文名 > 中文名 > Open ID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-usage-"));
    const file = join(dir, "skill-usage.jsonl");
    const usersFile = join(dir, "users.json");
    await writeFile(usersFile, JSON.stringify({
      ou_en: { openId: "ou_en", name: "张三", englishName: "John" },
      ou_zh: { openId: "ou_zh", name: "李四" },
      ou_bare: { openId: "ou_bare" },
    }), "utf8");

    const store = new SkillUsageStore(file, usersFile);
    expect(await store.resolveDisplayName("ou_en")).toBe("John");
    expect(await store.resolveDisplayName("ou_zh")).toBe("李四");
    expect(await store.resolveDisplayName("ou_bare")).toBe("ou_bare");
    expect(await store.resolveDisplayName("ou_unknown")).toBe("ou_unknown");
  });

  it("用户缓存文件缺失时回退为 Open ID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-usage-"));
    const store = new SkillUsageStore(join(dir, "skill-usage.jsonl"), join(dir, "missing.json"));
    expect(await store.resolveDisplayName("ou_x")).toBe("ou_x");
  });
});
