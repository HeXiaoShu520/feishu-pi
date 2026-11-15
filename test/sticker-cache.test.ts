import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCachedSticker } from "../src/feishu/sticker-cache.ts";
import * as previews from "../src/stickers/preview.ts";

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "sticker-cache-")); dirs.push(root);
  const cache = join(root, "cache"), session = join(root, "session");
  await mkdir(cache);
  const preview = vi.spyOn(previews, "previewSticker").mockResolvedValue({ data: Buffer.from("decoded PNG").toString("base64"), mimeType: "image/png" } as never);
  return { cache, session, preview };
}
describe("desktop sticker cache", () => {
  it("uses exact keys, copies to session, returns decoded preview on every repeated lookup", async () => {
    const { cache, session, preview } = await setup();
    await writeFile(join(cache, "v3_target.gif"), "original GIF");
    await writeFile(join(cache, "v3_other.png"), "unrelated newer image");
    for (let i = 0; i < 2; i++) {
      const image = await loadCachedSticker(cache, "v3_target", session, 100);
      expect(image?.mimeType).toBe("image/png");
      expect(Buffer.from(image!.data).toString()).toBe("decoded PNG");
    }
    expect(await readFile(join(session, "v3_target.gif"), "utf8")).toBe("original GIF");
    expect(preview).toHaveBeenCalledTimes(2);
  });
  it("never guesses another image, rejects path traversal and oversized sources", async () => {
    const { cache, session, preview } = await setup();
    await writeFile(join(cache, "existing.jpg"), "123456");
    for (const key of ["missing", "../existing", "existing.jpg", "C:\\existing", "existing"]) {
      expect(await loadCachedSticker(cache, key, session, 5)).toBeUndefined();
    }
    expect(await loadCachedSticker(undefined, "existing", session, 100)).toBeUndefined();
    expect(preview).not.toHaveBeenCalled();
  });
  it("does not claim visibility when decoding fails", async () => {
    const { cache, session, preview } = await setup();
    await writeFile(join(cache, "broken.png"), "not an image");
    preview.mockRejectedValue(new Error("invalid image"));
    expect(await loadCachedSticker(cache, "broken", session, 100)).toBeUndefined();
  });
});
