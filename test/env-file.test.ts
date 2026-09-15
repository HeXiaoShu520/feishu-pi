import { describe, expect, it } from "vitest";
import { parseEnvFile, stringifyEnv, upsertEnvLine } from "../src/utils/env-file.ts";

describe("parseEnvFile", () => {
  it("解析键值对，跳过注释与无 = 的行", () => {
    const parsed = parseEnvFile("# 注释\nFEISHU_APP_ID=cli_x\nBAD_LINE\nFEISHU_ADMIN=张三\n");
    expect(parsed).toEqual({ FEISHU_APP_ID: "cli_x", FEISHU_ADMIN: "张三" });
  });

  it("值中的 = 不被截断", () => {
    expect(parseEnvFile("A=b=c")["A"]).toBe("b=c");
  });
});

describe("stringifyEnv", () => {
  it("表单键写入标准分组结构", () => {
    const out = stringifyEnv({ FEISHU_APP_ID: "cli_x", FEISHU_PI_MODEL_NAME: "my-model" });
    expect(out).toContain("FEISHU_APP_ID=cli_x");
    expect(out).toContain("FEISHU_PI_MODEL_NAME=my-model");
    // 未提供的表单键写出缺省值，不残留 undefined
    expect(out).toContain("FEISHU_PI_MODEL_PROVIDER=anthropic");
    expect(out).not.toContain("undefined");
  });

  it("保留非 MANAGED_KEYS 的现有键（Guard/分组/超时等手工配置）", () => {
    const existing = parseEnvFile([
      "FEISHU_GUARD_BASE_URL=https://guard.example.com",
      "FEISHU_GUARD_MODELS=m1,m2",
      "FEISHU_GROUP_group1=李雷,韩梅梅",
      "FEISHU_APPROVAL_TIMEOUT_MS=300000",
    ].join("\n"));
    const out = stringifyEnv({ FEISHU_APP_ID: "cli_x" }, existing);
    expect(out).toContain("FEISHU_GUARD_BASE_URL=https://guard.example.com");
    expect(out).toContain("FEISHU_GROUP_group1=李雷,韩梅梅");
    expect(out).toContain("FEISHU_APPROVAL_TIMEOUT_MS=300000");
  });

  it("MANAGED_KEYS 不从 existing 重复追加（以表单值为准）", () => {
    const existing = parseEnvFile("FEISHU_APP_ID=old_id\nFEISHU_GROUP_admin=张三");
    const out = stringifyEnv({ FEISHU_APP_ID: "new_id" }, existing);
    expect(out).toContain("FEISHU_APP_ID=new_id");
    expect(out).not.toContain("old_id");
    expect(out).toContain("FEISHU_GROUP_admin=张三");
  });
});

describe("upsertEnvLine", () => {
  it("已有键原位替换，其余行原样保留", () => {
    const out = upsertEnvLine("A=1\nFEISHU_PI_MODEL_NAME=old\nB=2", "FEISHU_PI_MODEL_NAME", "new");
    expect(out).toContain("FEISHU_PI_MODEL_NAME=new");
    expect(out).not.toContain("old");
    expect(out).toContain("A=1");
    expect(out).toContain("B=2");
  });

  it("缺失键追加到末尾", () => {
    expect(upsertEnvLine("A=1\n", "K", "v")).toBe("A=1\nK=v\n");
    expect(upsertEnvLine("", "K", "v")).toBe("K=v\n");
  });
});

describe("stringifyEnv 值转义（防换行注入/多行破坏）", () => {
  it("值内换行折叠为空格，无法向 .env 注入任意键值对", () => {
    const out = stringifyEnv({
      FEISHU_APP_ID: "cli_x",
      FEISHU_ADMIN: "张三\nMINICLAW_VAULT_KEY=attacker_key",
    });
    // 注入文本折叠进同一行、成为值的一部分：parse 回来不存在独立注入键
    expect(out).not.toMatch(/\nMINICLAW_VAULT_KEY=/);
    const parsed = parseEnvFile(out);
    expect(Object.keys(parsed)).not.toContain("MINICLAW_VAULT_KEY");
    expect(parsed.FEISHU_ADMIN).toContain("MINICLAW_VAULT_KEY=attacker_key");
    expect(parsed.FEISHU_ADMIN.startsWith("张三 ")).toBe(true);
  });

  it("保留键的键名非法（空白/特殊字符）时跳过不写回；合法键值转义", () => {
    const out = stringifyEnv({ FEISHU_APP_ID: "x" }, {
      FEISHU_GROUP_admin: "李雷\n韩梅梅",
      "bad key\nINJECTED": "v",
    });
    expect(out).toContain("FEISHU_GROUP_admin=李雷 韩梅梅");
    expect(out).not.toContain("INJECTED");
  });

  it("upsertEnvLine 同样转义换行", () => {
    const out = upsertEnvLine("A=1\n", "K", "v1\nEVIL=2");
    expect(out).toContain("K=v1 EVIL=2");
    expect(out.indexOf("EVIL")).toBe(out.lastIndexOf("EVIL"));
  });
});
