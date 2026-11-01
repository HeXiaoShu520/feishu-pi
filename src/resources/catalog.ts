import type {
  DefaultResourceLoader,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { loadResourceConfig } from "./config.ts";
import { createProjectResourceLoader } from "./pi-loader.ts";
import { createToolRegistryAsync } from "../tools/registry.ts";

export interface ResourceSnapshot {
  loader: DefaultResourceLoader;
  tools: ToolDefinition[];
}

/** One resource snapshot per process; sessions share definitions, not execution state. */
export class AgentResources {
  private readonly cwd: string;
  private snapshot?: Promise<ResourceSnapshot>;
  constructor(cwd: string) {
    this.cwd = cwd;
  }
  load(): Promise<ResourceSnapshot> {
    this.snapshot ??= this.loadSnapshot().catch((error) => {
      this.snapshot = undefined;
      throw error;
    });
    return this.snapshot;
  }
  private async loadSnapshot(): Promise<ResourceSnapshot> {
    const config = await loadResourceConfig(this.cwd);
    const [loader, tools] = await Promise.all([
      createProjectResourceLoader(this.cwd, config),
      createToolRegistryAsync(this.cwd, config.tools),
    ]);
    return { loader, tools };
  }
}
