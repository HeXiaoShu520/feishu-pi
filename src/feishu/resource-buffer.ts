/**
 * 飞书资源下载响应统一收敛为 Buffer。
 *
 * SDK 不同接口/版本的返回形态不一：Buffer、`{ data: Buffer | Uint8Array | 流 }`、
 * `getReadableStream()`、以及需要落地临时文件的 `writeFile(path)` shim——
 * 这里按能力逐级探测，调用方无需关心差异。无法识别的结构抛错（含响应片段便于排查）。
 */
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 把可读流收集为 Buffer。 */
function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** 借助临时文件消费 writeFile 落地型响应：写入临时目录 → 读回 → 清理。 */
async function viaWriteFileShim(writeFileFn: (path: string) => Promise<void>): Promise<Buffer> {
  const tempPath = join(tmpdir(), `feishu-res-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await writeFileFn(tempPath);
  try {
    return await readFile(tempPath);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

/** 把资源下载接口的返回收敛为 Buffer；结构无法识别时抛错。 */
export async function toBuffer(res: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(res)) return res;
  if (res && typeof res === "object") {
    const obj = res as {
      data?: unknown;
      getReadableStream?: () => NodeJS.ReadableStream;
      writeFile?: (path: string) => Promise<void>;
    };
    if (typeof obj.getReadableStream === "function") return collectStream(obj.getReadableStream());
    if (Buffer.isBuffer(obj.data)) return obj.data;
    if (obj.data instanceof Uint8Array) return Buffer.from(obj.data);
    if (obj.data && typeof (obj.data as NodeJS.ReadableStream).on === "function") {
      return collectStream(obj.data as NodeJS.ReadableStream);
    }
    if (typeof obj.writeFile === "function") return viaWriteFileShim(obj.writeFile);
  }
  throw new Error(`无法识别的资源下载响应结构: ${String(res).slice(0, 200)}`);
}
