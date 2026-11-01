import "dotenv/config";
import { join } from "node:path";
import { AgentResources } from "../resources/catalog.ts";
import { loadMcpConfig } from "../mcp/config.ts";

async function main(): Promise<void> {
  const cwd = process.cwd();
  const [{ loader, tools }, servers] = await Promise.all([
    new AgentResources(cwd).load(),
    loadMcpConfig(join(cwd, ".agent", "mcp.json"), cwd),
  ]);
  console.log("Skills:");
  for (const skill of loader.getSkills().skills)
    console.log(
      `  ${skill.name}${skill.disableModelInvocation ? "（仅显式调用）" : ""}: ${skill.filePath}`,
    );
  console.log("Tools:");
  for (const tool of tools) console.log(`  ${tool.name}: ${tool.description}`);
  console.log("MCP（仅配置，不连接）:");
  for (const [name, config] of servers)
    console.log(`  ${name}: ${config.transport}`);
}
void main().catch((error) => {
  console.error(
    `[Resources] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
