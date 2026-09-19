/**
 * 历史会话文件脱敏：用凭证库中的已知密钥值扫描会话 jsonl，命中即替换为 ***。
 *
 * 仅清理库中已知的凭证值，不是对普通文本和工具结果的通用脱敏器。
 * 必须在接收消息前完成，避免改写正在追加的会话文件。
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "./logger.ts";

/** 最短清洗阈值：低于 4 字符的值误伤面太大，跳过 */
const MIN_SECRET_LEN = 4;

async function walkJsonlFiles(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkJsonlFiles(full, out);
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
}

/** 清洗目录下所有会话 jsonl 中的已知密钥值；返回替换发生处数。 */
export async function scrubSecretsInDir(dir: string, secrets: string[]): Promise<number> {
  const known = [...new Set(secrets)].filter((s) => s.length >= MIN_SECRET_LEN);
  if (known.length === 0) return 0;

  const files: string[] = [];
  try {
    await walkJsonlFiles(dir, files);
  } catch {
    return 0; // 目录不存在等：无事可清
  }

  let replaced = 0;
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      let scrubbed = content;
      for (const secret of known) {
        scrubbed = scrubbed.split(secret).join("***");
      }
      if (scrubbed !== content) {
        await writeFile(file, scrubbed, "utf8");
        replaced += 1;
      }
    } catch (error) {
      logger.warn(`[Scrub] 会话文件清洗失败 ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return replaced;
}
