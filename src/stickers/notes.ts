import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

/** Human-readable, one-image-one-file descriptions; image basenames are never model instructions. */
export interface StickerNote {
  image: string;
  sha256: string;
  description: string;
  motion: string;
  text: string;
  meaning: string;
  emotion: string;
  tags: string[];
  use: string;
  avoid: string;
  uncertainty: string;
  source: string;
}

export function notePaths(image: string): string[] {
  return [`${image}.txt`, image.slice(0, -extname(image).length) + ".txt"];
}

export function parseStickerNote(raw: string, image: string): StickerNote | undefined {
  if (raw.length > 16_000) return undefined;
  const fields = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const at = line.indexOf("：");
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const get = (key: string) => fields.get(key) ?? "";
  // Bind even colliding stems to the exact original file, including its extension.
  const required = ["画面", "动作", "图中文字", "表达含义", "情绪", "关键词", "适合接话", "不适合", "不确定处", "描述来源"];
  if (get("图片文件") !== basename(image) || required.some(key => !get(key)) || !/^[a-f0-9]{64}$/.test(get("图片SHA256"))) return undefined;
  return {
    image: get("图片文件"), sha256: get("图片SHA256"), description: get("画面"),
    motion: get("动作"), text: get("图中文字"), meaning: get("表达含义"),
    emotion: get("情绪"), tags: get("关键词").split("、").filter(Boolean),
    use: get("适合接话"), avoid: get("不适合"), uncertainty: get("不确定处"), source: get("描述来源"),
  };
}

/** Bound both the image and its neighbouring note to the library, including symlinks. */
export async function libraryPath(root: string, path: string): Promise<string> {
  const [base, target] = await Promise.all([realpath(root), realpath(path)]);
  const rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("表情路径超出图库目录");
  return target;
}

const cache = new Map<string, { stamp: string; note?: StickerNote }>();
export async function readStickerNote(root: string, image: string, options: { fresh?: boolean } = {}): Promise<StickerNote | undefined> {
  const rel = relative(resolve(root), resolve(image));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  for (const file of notePaths(image)) {
    try {
      const safe = await libraryPath(root, file);
      const info = await stat(safe);
      if (!info.isFile() || info.size > 16_000) continue;
      const stamp = `${info.mtimeMs}:${info.size}:${safe}`;
      const previous = cache.get(file);
      if (!options.fresh && previous?.stamp === stamp) return previous.note;
      const note = parseStickerNote(await readFile(safe, "utf8"), image);
      if (cache.size > 12_000) cache.clear();
      cache.set(file, { stamp, note });
      return note;
    } catch { /* Missing or unreadable notes are unknown, never fabricated descriptions. */ }
  }
  return undefined;
}
