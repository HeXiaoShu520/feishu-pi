import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Snapshots are immutable by content; restoring always saves the current version first. */
export class PersonaVersions {
  private readonly agentDir: string;
  constructor(agentDir: string) { this.agentDir = agentDir; }
  private get directory() { return join(this.agentDir, "personas", "versions"); }
  private get current() { return join(this.agentDir, "SYSTEM.md"); }
  async save(): Promise<string> {
    const content = await readFile(this.current, "utf8");
    await mkdir(this.directory, { recursive: true });
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${hash}`;
    await writeFile(join(this.directory, `${id}.md`), content, { encoding: "utf8", flag: "wx" });
    return id;
  }
  async list(): Promise<string[]> {
    const files = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    return files.filter((file) => /^\d{4}-\d\d-\d\dT[\d-]+Z_[a-f0-9]{16}\.md$/.test(file)).map((file) => file.slice(0, -3)).sort().reverse();
  }
  async restore(id: string): Promise<string> {
    if (!/^\d{4}-\d\d-\d\dT[\d-]+Z_[a-f0-9]{16}$/.test(id)) throw new Error("人格版本 ID 无效");
    const content = await readFile(join(this.directory, `${id}.md`), "utf8");
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
    if (!id.endsWith(`_${hash}`)) throw new Error("人格版本内容已损坏或被修改");
    const backup = await this.save();
    const tmp = join(this.agentDir, `.system-${randomUUID()}.tmp`);
    await writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
    await rename(tmp, this.current);
    return backup;
  }
}
