import type { Client } from "@larksuiteoapi/node-sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;
const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase();

/** Resolve one explicitly configured person. Never enumerate a department or team at startup. */
export async function resolveOwnerOpenId(client: Client, identifier: string, appId: string, dataDir = join(process.cwd(), "data", "users")): Promise<string | undefined> {
  identifier = identifier.trim();
  if (OPEN_ID.test(identifier)) return identifier;
  if (!identifier) return undefined;

  const cache: unknown = await readFile(join(dataDir, `${appId}_users.json`), "utf8")
    .then((text) => JSON.parse(text) as unknown).catch(() => ({}));
  const entries = cache && typeof cache === "object" && !Array.isArray(cache) ? Object.entries(cache) : [];
  const target = normalize(identifier);
  const matches = entries.filter(([openId, profile]) => {
    if (!OPEN_ID.test(openId) || !profile || typeof profile !== "object" || Array.isArray(profile)) return false;
    const person = profile as { name?: unknown; en_name?: unknown; email?: unknown };
    return [person.name, person.en_name, person.email].some((value) => typeof value === "string" && normalize(value) === target);
  });
  if (matches.length === 1) return matches[0][0];
  if (matches.length > 1 || !identifier.includes("@")) return undefined;
  const result = await client.contact.user.batchGetId({ params: { user_id_type: "open_id" }, data: { emails: [identifier] } }).catch(() => undefined);
  const openId = result?.code === 0 ? result.data?.user_list?.[0]?.user_id : undefined;
  return openId && OPEN_ID.test(openId) ? openId : undefined;
}
