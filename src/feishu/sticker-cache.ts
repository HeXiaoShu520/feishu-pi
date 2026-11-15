import { open, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { libraryPath } from "../stickers/notes.ts";
import { previewSticker } from "../stickers/preview.ts";
import type { ProcessedImage } from "./image-processor.ts";

/** Read only an exact event key from an explicitly configured desktop account cache.
 * No directory scanning, newest-file guessing, network download or model-chosen path.
 */
export async function loadCachedSticker(cacheDir: string | undefined, key: string | undefined,
  sessionImagesDir: string, maxBytes: number): Promise<ProcessedImage | undefined> {
  if (!cacheDir || !key || !/^[A-Za-z0-9_-]{1,200}$/.test(key) || maxBytes <= 0) return undefined;
  for (const ext of ["png", "jpg", "jpeg", "webp", "gif"]) {
    try {
      const source = await libraryPath(cacheDir, join(cacheDir, `${key}.${ext}`));
      const handle = await open(source, "r");
      let data: Buffer;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size < 1 || info.size > maxBytes) continue;
        // Bounded even if the client grows the file between stat and read.
        const buffer = Buffer.alloc(Math.min(maxBytes, info.size) + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== info.size) continue;
        data = buffer.subarray(0, bytesRead);
      } finally { await handle.close(); }
      await mkdir(sessionImagesDir, { recursive: true });
      const savedPath = join(sessionImagesDir, `${key}.${ext}`);
      await writeFile(savedPath, data);
      // Decode actual contents; also turns GIF/animated WebP into a multi-frame PNG.
      const preview = await previewSticker(sessionImagesDir, savedPath);
      const decoded = Buffer.from(preview.data, "base64");
      if (decoded.length > maxBytes) return undefined;
      return { data: new Uint8Array(decoded), mimeType: preview.mimeType, savedPath };
    } catch { /* Missing, still being written or invalid: leave visibility unknown. */ }
  }
  return undefined;
}
