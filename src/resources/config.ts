import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { matchGlobs } from "../utils/path-glob.ts";

export interface ResourceSelection {
  enabled: boolean;
  include: string[];
  exclude: string[];
}
export interface ResourceConfig {
  skills: ResourceSelection & { paths: string[] };
  tools: ResourceSelection;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}
function strings(value: unknown, fallback: string[], field: string): string[] {
  if (value === undefined) return fallback;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  )
    throw new Error(`${field} 必须是非空字符串数组`);
  return value as string[];
}
function selection(value: unknown, field: string): ResourceSelection {
  const input = value === undefined ? {} : record(value, field);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    throw new Error(`${field}.enabled 必须是布尔值`);
  return {
    enabled: input.enabled !== false,
    include: strings(input.include, ["*"], `${field}.include`),
    exclude: strings(input.exclude, [], `${field}.exclude`),
  };
}

/** Discovery controls exposure; execution permissions remain a separate boundary. */
export async function loadResourceConfig(cwd: string): Promise<ResourceConfig> {
  const source = await readFile(
    join(cwd, ".agent", "resources.json"),
    "utf8",
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  });
  const raw = record(JSON.parse(source), "resources.json");
  const skills = raw.skills === undefined ? {} : record(raw.skills, "skills");
  return {
    skills: {
      ...selection(skills, "skills"),
      paths: strings(skills.paths, [], "skills.paths").map((path) =>
        resolve(cwd, path),
      ),
    },
    tools: selection(raw.tools, "tools"),
  };
}
export function resourceEnabled(
  selection: ResourceSelection,
  name: string,
): boolean {
  return (
    selection.enabled &&
    matchGlobs(selection.include, name) &&
    !matchGlobs(selection.exclude, name)
  );
}
