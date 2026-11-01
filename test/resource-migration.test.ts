import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPages } from "../src/mcp/pagination.ts";
import { loadResourceConfig } from "../src/resources/config.ts";
import { createToolRegistryAsync } from "../src/tools/registry.ts";
import { loadMcpConfig } from "../src/mcp/config.ts";
import { runProcess } from "../src/process/runner.ts";

describe("MCP pagination", () => {
  it("collects all pages and rejects cyclic cursors", async () => {
    expect(await collectPages(async (cursor) => cursor ? { values: [2] } : { values: [1], nextCursor: "next" }, (page) => page.values)).toEqual([1, 2]);
    await expect(collectPages(async () => ({ values: [1], nextCursor: "same" }), (page) => page.values)).rejects.toThrow("重复分页游标");
  });
});

describe("MCP configuration", () => {
  it("accepts streamable-http aliases and validates enabled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "feishu-mcp-"));
    try {
      const file = join(cwd, "mcp.json");
      await writeFile(file, JSON.stringify({ mcpServers: { remote: { type: "streamable-http", url: "https://example.com/mcp" } } }));
      expect((await loadMcpConfig(file, cwd)).get("remote")?.transport).toBe("http");
      await writeFile(file, JSON.stringify({ mcpServers: { remote: { enabled: "false" } } }));
      await expect(loadMcpConfig(file, cwd)).rejects.toThrow("enabled");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});

describe("resource discovery", () => {
  it("selects directory tools and retains Python tool discovery", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "feishu-resources-"));
    try {
      const dir = join(cwd, ".agent", "tools");
      await mkdir(join(dir, "nested"), { recursive: true });
      await writeFile(join(dir, "nested", "index.mjs"), 'export default {name:"nested_tool", description:"nested", parameters:{type:"object"}, execute:async()=>({content:[],details:{}})}');
      await writeFile(join(dir, "legacy.py"), '#! {"name":"legacy_tool","description":"legacy"}\n');
      await writeFile(join(cwd, ".agent", "resources.json"), JSON.stringify({ tools: { include: ["nested_tool", "legacy_tool"] } }));
      const config = await loadResourceConfig(cwd);
      expect((await createToolRegistryAsync(cwd, config.tools)).map(t => t.name).sort()).toEqual(["legacy_tool", "nested_tool"]);
      expect(await createToolRegistryAsync(cwd, { enabled: false, include: ["*"], exclude: [] })).toEqual([]);
      config.tools.exclude = ["legacy_tool"];
      expect((await createToolRegistryAsync(cwd, config.tools)).map(t => t.name)).toEqual(["nested_tool"]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it("rejects conflicting tools", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "feishu-resources-"));
    try {
      const dir = join(cwd, ".agent", "tools"); await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "bad.mjs"), 'export default {name:"read",description:"bad",parameters:{type:"object"},execute:async()=>({content:[],details:{}})}');
      await expect(createToolRegistryAsync(cwd)).rejects.toThrow("冲突");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it("passes JSON data to a child process over stdin", async () => {
    const result = await runProcess(process.execPath, ["-e", "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.parse(s).text))"], { cwd: process.cwd(), input: JSON.stringify({ text: "hello" }) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });
});
