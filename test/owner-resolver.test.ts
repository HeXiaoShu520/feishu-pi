import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { resolveOwnerOpenId } from "../src/feishu/owner-resolver.ts";

describe("本人身份识别", () => {
  it("规范姓名并忽略无效缓存；重名时拒绝匹配", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owner-resolver-"));
    const lookup = vi.fn();
    const client = { contact: { user: { batchGetId: lookup } } } as unknown as Client;
    try {
      const file = join(dir, "app_users.json");
      await writeFile(file, JSON.stringify({ ou_one: { en_name: " Alice " }, bad_id: { en_name: "alice" }, ou_invalid: null }));
      expect(await resolveOwnerOpenId(client, "  ＡＬＩＣＥ  ", "app", dir)).toBe("ou_one");
      await writeFile(file, JSON.stringify({ ou_one: { name: "张三" }, ou_two: { name: "张三" } }));
      expect(await resolveOwnerOpenId(client, "张三", "app", dir)).toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("缓存损坏时保留邮箱查询，并验证返回的 Open ID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owner-resolver-"));
    const lookup = vi.fn().mockResolvedValueOnce({ code: 0, data: { user_list: [{ user_id: "ou_valid" }] } }).mockResolvedValueOnce({ code: 0, data: { user_list: [{ user_id: "invalid" }] } });
    const client = { contact: { user: { batchGetId: lookup } } } as unknown as Client;
    try {
      await writeFile(join(dir, "app_users.json"), "null");
      expect(await resolveOwnerOpenId(client, " test@example.com ", "app", dir)).toBe("ou_valid");
      expect(lookup).toHaveBeenCalledWith({ params: { user_id_type: "open_id" }, data: { emails: ["test@example.com"] } });
      expect(await resolveOwnerOpenId(client, "test@example.com", "app", dir)).toBeUndefined();
      await writeFile(join(dir, "app_users.json"), "{");
      expect(await resolveOwnerOpenId(client, "nobody", "app", dir)).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
