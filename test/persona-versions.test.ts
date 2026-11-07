import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonaVersions } from "../src/resources/persona-versions.ts";

describe("人格版本", () => {
  it("保存、恢复，并保存恢复前的内容", async () => {
    const root = await mkdtemp(join(tmpdir(), "persona-"));
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "SYSTEM.md"), "old personality");
      const v = new PersonaVersions(root); const id = await v.save();
      await writeFile(join(root, "SYSTEM.md"), "new personality");
      const backup = await v.restore(id);
      expect(await readFile(join(root, "SYSTEM.md"), "utf8")).toBe("old personality");
      expect(await readFile(join(root, "personas", "versions", `${backup}.md`), "utf8")).toBe("new personality");
      expect(await v.list()).toContain(id);
      await expect(v.restore("../../SYSTEM")).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("内容未变时重复 save 复用最新版本，不堆积快照", async () => {
    const root = await mkdtemp(join(tmpdir(), "persona-"));
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "SYSTEM.md"), "same content");
      const v = new PersonaVersions(root);
      const first = await v.save();
      const second = await v.save();
      expect(second).toBe(first);
      await expect(v.list()).resolves.toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
