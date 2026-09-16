import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/utils/redact.ts";

describe("redactSecrets（对话历史脱敏）", () => {
  it("遮蔽 JWT 形态的飞书 user token", () => {
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig-part-here";
    const out = redactSecrets(`我的 token：${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain("eyJh***");
    expect(out).toContain("我的 token：");
  });

  it("遮蔽 Bearer 头（保留 Bearer 前缀）", () => {
    const out = redactSecrets("Authorization: Bearer abcd1234efgh5678ijkl");
    expect(out).toContain("Bearer ");
    expect(out).not.toContain("abcd1234efgh5678ijkl");
    expect(out).toMatch(/Bearer abcd\*\*\*kl/);
  });

  it("遮蔽键值形态的凭证提交（password/token/app_password=值）", () => {
    const out = redactSecrets('/login bbt 提交 app_password="ATATT3xFfGF0examplevalue1234567890"');
    expect(out).not.toContain("ATATT3xFfGF0examplevalue1234567890");
    expect(out).toContain("app_password=");
  });

  it("遮蔽 40+ 位高熵长串（通用 access/refresh token 形态）", () => {
    const longToken = "URT-9f2d8c7b6a5e4f3d2c1b0a998877665544332211ffeeddccbbaa9988";
    const out = redactSecrets(`refresh_token: ${longToken} 请帮我配置`);
    expect(out).not.toContain(longToken);
    expect(out).toContain("refresh_token:");
  });

  it("遮蔽 32 位 hex（bitbucket app password 形态）", () => {
    const hex = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const out = redactSecrets(`这是我的 bitbucket 密码 ${hex}`);
    expect(out).not.toContain(hex);
  });

  it("凭证含 $ 替换特殊序列（如 $1）时按字面量遮蔽，不展开", () => {
    const secret = "ab$1cdefghij90";
    const out = redactSecrets(`token=ab$1cdefghij90`);
    expect(out).not.toContain(secret);
    expect(out).toContain("ab$1***90");
  });

  it("不误伤普通文本与常见标识（open_id / 命令）", () => {
    const plain = "请把这份文档发给我 /login lark 我的 open_id 是 ou_764f63ac51563aa4b6c98a17f510a6f7";
    expect(redactSecrets(plain)).toBe(plain);
  });
});

describe("CLI flag 形态脱敏（bbt 等明文参数 CLI）", () => {
  it("--password/--user 的值遮蔽；等号/引号形态同样命中", () => {
    expect(redactSecrets("bbt pr create --password s3cret!")).not.toContain("s3cret!");
    expect(redactSecrets('bbt pr create --user alice --password "p@ss w0rd"')).not.toContain("alice");
    expect(redactSecrets("bbt --token=abcdef1234567890")).not.toContain("abcdef1234567890");
  });

  it("$ 开头的环境变量引用不遮蔽", () => {
    const cmd = 'bbt pr create --user "$BBT_USERNAME" --password "$BBT_PASSWORD"';
    expect(redactSecrets(cmd)).toBe(cmd);
  });
});
