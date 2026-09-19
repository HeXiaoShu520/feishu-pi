import { describe, expect, it } from "vitest";
import { upsertEnvLine } from "../src/utils/env-file.ts";

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

  it("值内换行折叠为空格（防破坏 .env 逐行解析/注入键值对）", () => {
    const out = upsertEnvLine("A=1\n", "K", "v1\nEVIL=2");
    expect(out).toBe("A=1\nK=v1 EVIL=2\n");
  });
});


it("值中的美元替换符按字面保存", () => {
  expect(upsertEnvLine("MODEL=old\n", "MODEL", "model-$&")).toBe("MODEL=model-$&\n");
});
