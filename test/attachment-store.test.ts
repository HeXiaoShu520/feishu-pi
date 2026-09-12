import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFileAttachments } from "../src/feishu/lark-transport.ts";

describe("附件存进统一会话文件夹的 files/ 子目录", () => {
  it("文件落在 {会话目录}/files/ 下，文件名带时间戳前缀；非文件类资源忽略", async () => {
    const root = await mkdtemp(join(tmpdir(), "sessions-"));
    const note = await downloadFileAttachments(
      root,
      "topic:oc_abc:om_root",
      [
        { type: "file", fileKey: "key1", fileName: "报表.xlsx" },
        { type: "image", fileKey: "img1" }, // 图片走 imageProcessor，不归这里
      ],
      async () => Buffer.from("data"),
    );

    const filesDir = join(root, "topic_oc_abc_om_root", "files");
    expect(note).toContain("报表.xlsx");
    expect(note).toContain(filesDir);

    // files/ 内恰好一个文件：{时间戳}-原始文件名
    const entries = await readdir(filesDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^\d+-报表\.xlsx$/);
    expect(await readFile(join(filesDir, entries[0]), "utf8")).toBe("data");
    // 根目录下只新建了会话文件夹这一个入口
    expect(await readdir(root)).toEqual(["topic_oc_abc_om_root"]);
  });

  it("单条消息最多下载 5 个附件，单个失败不影响其余", async () => {
    const root = await mkdtemp(join(tmpdir(), "sessions-"));
    const resources = Array.from({ length: 7 }, (_, i) => ({ type: "file", fileKey: `k${i}`, fileName: `f${i}.txt` }));
    let calls = 0;
    const note = await downloadFileAttachments(root, "ou_x-chat:oc_y", resources, async () => {
      calls += 1;
      if (calls === 2) throw new Error("boom");
      return Buffer.from("d");
    });

    expect(calls).toBe(5); // 第 6、7 个不再尝试
    const entries = await readdir(join(root, "ou_x-chat_oc_y", "files"));
    expect(entries).toHaveLength(4); // 第 2 个失败，落盘 4 个
    expect(note.split("\n[附件]")).toHaveLength(5); // 说明含开头空行共 4 条
  });

  it("无文件类附件时返回空串且不建目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "sessions-"));
    const note = await downloadFileAttachments(root, "ou_x-chat:oc_y", [{ type: "image", fileKey: "img1" }], async () => Buffer.alloc(0));
    expect(note).toBe("");
    expect(await readdir(root)).toEqual([]);
  });
});
