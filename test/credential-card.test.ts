import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCredentialFormCard, extractCredentialFields } from "../src/feishu/credential-card.ts";
import { StaticCredentialService } from "../src/feishu/meegle-auth.ts";

describe("buildCredentialFormCard（表单容器 + 输入框 + form_submit 按钮）", () => {
  const card = buildCredentialFormCard({
    provider: "bbt",
    title: "🔑 Bitbucket 凭证提交",
    intro: "填写后提交",
    fields: [
      { name: "username", label: "用户名", inputType: "text", maxLength: 200 },
      { name: "password", label: "App Password", inputType: "password", required: true },
    ],
    notice: "仅加密存储",
  }) as {
    schema: string;
    header: { title: { content: string } };
    body: { elements: Array<Record<string, unknown>> };
  };

  it("schema 2.0；body 含 intro、form 容器、notice", () => {
    expect(card.schema).toBe("2.0");
    expect(card.header.title.content).toContain("Bitbucket");
    const tags = card.body.elements.map((e) => e.tag);
    expect(tags).toEqual(["markdown", "form", "markdown"]);
  });

  it("form 容器内：输入框带 name/input_type/required；提交按钮 action_type=form_submit 且回传 provider", () => {
    const form = card.body.elements[1] as {
      tag: string;
      name: string;
      elements: Array<Record<string, unknown>>;
    };
    expect(form.tag).toBe("form");
    const inputs = form.elements.filter((e) => e.tag === "input") as Array<Record<string, unknown>>;
    expect(inputs.length).toBe(2);
    expect(inputs[0]).toMatchObject({ name: "username", input_type: "text", max_length: 200, required: true });
    expect(inputs[1]).toMatchObject({ name: "password", input_type: "password", required: true });

    const submit = form.elements.find((e) => e.action_type === "form_submit") as {
      behaviors: Array<{ value: Record<string, unknown> }>;
    };
    expect(submit.behaviors[0].value).toEqual({ action: "credential_submit", provider: "bbt" });
    // 重置按钮存在
    expect(form.elements.some((e) => e.action_type === "form_reset")).toBe(true);
  });
});

describe("extractCredentialFields（表单回调字段提取）", () => {
  it("form_value 优先：字符串保留、trim、空值/非字符串剔除", () => {
    const fields = extractCredentialFields({
      form_value: { username: " alice ", password: "   ", empty: "", nested: { x: 1 } },
      input_value: "ignored",
    });
    expect(fields).toEqual({ username: "alice" });
  });

  it("无 form_value 时回退 input_value（键记为 value）", () => {
    expect(extractCredentialFields({ input_value: "tok_123" })).toEqual({ value: "tok_123" });
    expect(extractCredentialFields(undefined)).toEqual({});
    expect(extractCredentialFields({ form_value: {}, input_value: "   " })).toEqual({});
  });
});

describe("StaticCredentialService（meegle/bbt 静态凭证存取）", () => {
  it("submitFields/peekFields 往返；logout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "staticcred-"));
    const svc = new StaticCredentialService(join(dir, "bbt.vault.json"), join(dir, ".vault-key"), "bbt");
    expect(svc.peekFields("ou_x")).toBeUndefined();

    await svc.submitFields("ou_x", { username: "alice", password: "secret" });
    expect(svc.peekFields("ou_x")).toEqual({ username: "alice", password: "secret" });
    expect(await svc.logout("ou_x")).toBe(true);
    expect(svc.peekFields("ou_x")).toBeUndefined();
    expect(await svc.logout("ou_x")).toBe(false);
  });

  it("submitToken/peekToken 单 token 形态；不同 provider 命名空间互不可见", async () => {
    const dir = await mkdtemp(join(tmpdir(), "staticcred-"));
    const keyFile = join(dir, ".vault-key");
    const meegle = new StaticCredentialService(join(dir, "share.vault.json"), keyFile, "meegle");
    const bbt = new StaticCredentialService(join(dir, "share.vault.json"), keyFile, "bbt");

    await meegle.submitToken("ou_m", "mtok");
    expect(meegle.peekToken("ou_m")).toBe("mtok");
    expect(bbt.peekToken("ou_m")).toBeUndefined();
    expect(bbt.peekFields("ou_m")).toBeUndefined();
  });
});
