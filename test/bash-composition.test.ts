import { describe, expect, it } from "vitest";
import { allowCompositeCommand, splitShellSegments } from "../src/guard/tool-guard.ts";

const CWD = "E:/proj";
const allow = (seg: string): boolean => /^(ls|grep|cat|head|tail|git status)(\s|$)/.test(seg);

describe("组合命令白名单（allowCompositeCommand）", () => {
  it("cd 工程内 && 白名单命令链 → 放行", () => {
    const cmd = 'cd "E:/proj" && grep -rn foo src/ | head -20';
    expect(allowCompositeCommand(cmd, CWD, allow)).toBe(true);
  });

  it("cd 出工作目录 → 不放行（交审核）", () => {
    expect(allowCompositeCommand("cd E:/other && ls", CWD, allow)).toBe(false);
    expect(allowCompositeCommand("cd .. && ls", CWD, allow)).toBe(false);
  });

  it("含命令替换 $() 或反引号 → 不放行", () => {
    expect(allowCompositeCommand('cd E:/proj && echo $(rm -rf /)', CWD, allow)).toBe(false);
    expect(allowCompositeCommand("cd E:/proj && echo `rm -rf /`", CWD, allow)).toBe(false);
  });

  it("某段不在白名单 → 不放行", () => {
    expect(allowCompositeCommand("cd E:/proj && ls && rm -rf build", CWD, allow)).toBe(false);
  });

  it("引号内的 && 不拆段（字面数据，不构成拼接）", () => {
    const segments = splitShellSegments('grep "a && b" file');
    expect(segments).toEqual(['grep "a && b" file']);
    // 引号内 && 是字面文本：以 grep 开头即放行（正确——它不会被 shell 当链接符执行）
    expect(allowCompositeCommand('grep "a && b" file', CWD, allow)).toBe(true);
    // 更严格的白名单（模拟 policy 的逃逸 veto）：含 && 的段不放行、交审核
    expect(allowCompositeCommand('grep "a && b" file', CWD, (s) => !s.includes("&&") && allow(s))).toBe(false);
  });

  it("纯单命令走同一判定", () => {
    expect(allowCompositeCommand("ls -la", CWD, allow)).toBe(true);
    expect(allowCompositeCommand("rm -rf build", CWD, allow)).toBe(false);
  });
});
