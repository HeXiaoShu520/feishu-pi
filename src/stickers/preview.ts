import { fileURLToPath } from "node:url";
import { runProcess } from "../process/runner.ts";
import { libraryPath } from "./notes.ts";

export interface StickerPreview {
  data: string;
  mimeType: "image/png";
  sha256: string;
  frameCount: number;
  sampledFrames: number[];
  durationMs: number;
  warning?: string;
  background?: string;
}

/** Decode only a resolved catalogue image; the model cannot choose a command or arbitrary file. */
export async function previewSticker(root: string, path: string, signal?: AbortSignal): Promise<StickerPreview> {
  const safe = await libraryPath(root, path);
  const script = fileURLToPath(new URL("../../tools/sticker-frames.py", import.meta.url));
  const result = await runProcess(process.env.FEISHU_STICKER_PYTHON || "python", [script], {
    cwd: root, input: JSON.stringify({ path: safe }), signal, timeoutMs: 60_000, maxChars: 8 * 1024 * 1024,
  });
  if (result.exitCode !== 0 || result.truncated) throw new Error("无法生成表情预览，请检查图片与 Python/Pillow；未发送图片");
  const value = JSON.parse(result.stdout) as StickerPreview;
  if (!value.data || value.mimeType !== "image/png" || !/^[a-f0-9]{64}$/.test(value.sha256) || !Array.isArray(value.sampledFrames)) throw new Error("表情预览无效，未发送图片");
  return value;
}
